-- =============================================================================
-- worker.sql - Auto-rule background sweeps (PRD L48-57 "Auto-Rule Background
-- Worker", PRD L133-153 state machine, PRD L137 / L142 / L148).
--
-- CONTRACT
--   Each sweep is a SELECT that RETURNS the affected visit ids and does NOT
--   mutate anything. The worker then, inside the SAME transaction per batch:
--     1. runs the sweep        -> the rows are already locked, so the ids cannot
--                                be re-selected by a second worker instance;
--     2. UpdateVisitStatus     -> requested->cancelled | approved->not_visit
--                                | visiting->completed;
--     3. InsertStatusHistory   -> changed_by = NULL, notes = the rule id.
--   Keeping the mutation out of the query file is what lets the caller batch the
--   whole sweep into one atomic, auditable transaction (PRD L129).
--
--   FOR UPDATE ... SKIP LOCKED is mandatory: a single-tick sweeper must not block
--   on - or double-process - rows another instance is already migrating.
--
-- R1  requested, untouched for 7 days   -> cancelled   (PRD L137 "Timeout 7 Hari")
-- R2  approved, window already closed,
--     never checked in                   -> not_visit   (PRD L142 "No Show")
-- R3  visiting, end_date + 24h elapsed   -> completed   (PRD L148 "Auto-Complete")
--
-- R2 derives its 2-hour grace from the check-in validity window
-- [start_date - 2h, end_date + 2h] (AGENTS.md rule 6.2, PRD L121-123, QA
-- GATE-05): once now() > end_date + 2h the guard can no longer perform a
-- legitimate check-in, so the visit is definitively a no-show.
-- =============================================================================

-- name: SweepStaleRequestedVisits :many
-- R1: an unanswered request 7 days old is abandoned (PRD L137).
SELECT vr.id, vr.visit_id, vr.status, vr.pic_user_id, vr.location_id, vr.start_date, vr.end_date
FROM visit_request vr
WHERE vr.status = 'requested'
  AND vr.created_at < now() - interval '7 days'
ORDER BY vr.created_at ASC
FOR UPDATE OF vr SKIP LOCKED;

-- name: SweepNoShowApprovedVisits :many
-- R2: approved, past end_date + 2h, and check_in has no row for the visit.
-- Uses idx_visit_status for the status scan and the UNIQUE index on
-- check_in(visit_request_id) for the anti-join probe.
SELECT vr.id, vr.visit_id, vr.status, vr.pic_user_id, vr.location_id, vr.start_date, vr.end_date
FROM visit_request vr
WHERE vr.status = 'approved'
  AND vr.end_date < now() - interval '2 hours'
  AND NOT EXISTS (SELECT 1 FROM check_in ci WHERE ci.visit_request_id = vr.id)
ORDER BY vr.end_date ASC
FOR UPDATE OF vr SKIP LOCKED;

-- name: SweepStaleVisitingVisits :many
-- R3: still 'visiting' a full day after the scheduled end (PRD L148). idx_visit_date
-- does not cover end_date, so this sweep relies on the status index plus the
-- row count of a single overnight window - deliberately not adding a 5th index
-- beyond the four PRD L206-209 mandates, since the sweep runs once per tick.
SELECT vr.id, vr.visit_id, vr.status, vr.pic_user_id, vr.location_id, vr.start_date, vr.end_date
FROM visit_request vr
WHERE vr.status = 'visiting'
  AND vr.end_date < now() - interval '24 hours'
ORDER BY vr.end_date ASC
FOR UPDATE OF vr SKIP LOCKED;
