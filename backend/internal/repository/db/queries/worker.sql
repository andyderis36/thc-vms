-- =============================================================================
-- worker.sql - Auto-rule background sweeps (PRD L48-57 "Auto-Rule Background
-- Worker", PRD L133-153 state machine, PRD L137 / L142 / L148).
--
-- CONTRACT
--   Each sweep is a SELECT that RETURNS the affected visit ids and does NOT
--   mutate anything. The worker then, inside the SAME transaction per batch:
--     1. runs the sweep        -> the rows are already locked, so the ids cannot
--                                be re-selected by a second worker instance;
--     2. UpdateVisitStatus     -> requested->cancelled | (requested|approved|
--                                rescheduled)->not_visit | visiting->completed;
--     3. InsertStatusHistory   -> changed_by = NULL, notes = the rule id.
--   Keeping the mutation out of the query file is what lets the caller batch the
--   whole sweep into one atomic, auditable transaction (PRD L129).
--
--   FOR UPDATE ... SKIP LOCKED is mandatory: a single-tick sweeper must not block
--   on - or double-process - rows another instance is already migrating.
--
-- R1  requested, untouched for 7 days   -> cancelled   (PRD L137 "Timeout 7 Hari")
-- R2  pre-arrival (requested | approved | rescheduled),
--     window already closed,
--     never checked in                   -> not_visit   (PRD L142 "No Show")
-- R3  visiting, end_date + 24h elapsed   -> completed   (PRD L148 "Auto-Complete")
--
-- R2 derives its 2-hour grace from the check-in validity window
-- [start_date - 2h, end_date + 2h] (AGENTS.md rule 6.2, PRD L121-123, QA
-- GATE-05): once now() > end_date + 2h the guard can no longer perform a
-- legitimate check-in, so the visit is definitively a no-show. The grace is
-- domain.NoShowGrace; keep the two in step.
--
-- R1 and R2 predicates are DISJOINT on end_date: R2 owns end_date <= now()-2h,
-- R1 owns end_date > now()-2h, together partitioning every requested row.
-- =============================================================================

-- name: SweepStaleRequestedVisits :many
-- R1: an unanswered request 7 days old is abandoned (PRD L137). Only requests
-- whose window has NOT fully closed are R1's business: an overdue request is
-- claimed by R2 instead, so end_date > now()-2h keeps the two sweeps disjoint.
-- Capped at 500 rows per tick (S4): one sweep locks and migrates at most one
-- batch, never the whole table.
SELECT vr.id, vr.visit_id, vr.status, vr.vendor_user_id, vr.location_id, vr.start_date, vr.end_date
FROM visit_request vr
WHERE vr.status = 'requested'
  AND vr.created_at < now() - interval '7 days'
  AND vr.end_date > now() - interval '2 hours'
ORDER BY vr.created_at ASC
LIMIT 500
FOR UPDATE OF vr SKIP LOCKED;

-- name: SweepNoShowVisits :many
-- R2: any pre-arrival status, past end_date + 2h (domain.NoShowGrace), and
-- check_in has no row for the visit. Uses idx_visit_status for the status scan
-- and the UNIQUE index on check_in(visit_request_id) for the anti-join probe.
-- Capped at 500 rows per tick (S4), same as its sibling sweeps.
SELECT vr.id, vr.visit_id, vr.status, vr.vendor_user_id, vr.location_id, vr.start_date, vr.end_date
FROM visit_request vr
WHERE vr.status IN ('requested', 'approved', 'rescheduled')
  AND vr.end_date <= now() - interval '2 hours'
  AND NOT EXISTS (SELECT 1 FROM check_in ci WHERE ci.visit_request_id = vr.id)
ORDER BY vr.end_date ASC
LIMIT 500
FOR UPDATE OF vr SKIP LOCKED;

-- name: SweepStaleVisitingVisits :many
-- R3: still 'visiting' a full day after the scheduled end (PRD L148). idx_visit_date
-- does not cover end_date, so this sweep relies on the status index plus the
-- row count of a single overnight window - deliberately not adding a 5th index
-- beyond the four PRD L206-209 mandates, since the sweep runs once per tick.
-- Capped at 500 rows per tick (S4), same as its sibling sweeps.
SELECT vr.id, vr.visit_id, vr.status, vr.vendor_user_id, vr.location_id, vr.start_date, vr.end_date
FROM visit_request vr
WHERE vr.status = 'visiting'
  AND vr.end_date < now() - interval '24 hours'
ORDER BY vr.end_date ASC
LIMIT 500
FOR UPDATE OF vr SKIP LOCKED;

-- R4  approved, starts within the reminder window -> notify (no status change)
-- R4 differs from R1-R3 in one decisive way: it MUTATES NOTHING. It only needs
-- a read of the due visits so the worker can INSERT a reminder notification;
-- the idempotency comes from the notification unique constraint, not from a row
-- lock. Hence: no FOR UPDATE / SKIP LOCKED (a lock would be pointless and would
-- make concurrent sweeps queue for no reason).

-- name: SweepUpcomingApprovedVisits :many
-- R4: approved visits whose start_date falls inside (now, window_end]. The window
-- bounds are BOUND parameters so the worker's injected clock - and therefore the
-- 45-minute ReminderWindow - drives the rule and stays unit-testable.
-- Capped at 500 rows per tick, matching the sibling sweeps.
SELECT vr.id, vr.visit_id, vr.status, vr.vendor_user_id, vr.location_id, vr.start_date, vr.end_date
FROM visit_request vr
WHERE vr.status = 'approved'
  AND vr.start_date > sqlc.arg('now')::timestamptz
  AND vr.start_date <= sqlc.arg('window_end')::timestamptz
ORDER BY vr.start_date ASC
LIMIT 500;

-- name: GetVisitsByIDs :many
-- Batched detail read for the auto-rule worker hydrate(): one round trip for
-- a whole capped sweep instead of FindByID-per-id (S1 N+1 kill). The
-- projection is byte-for-byte the GetVisitByID one (visits.sql) so the same
-- domain mapping applies; callers restore sweep order themselves.
SELECT
    vr.id, vr.visit_id, vr.vendor_user_id, vr.vendor_id, vr.location_id, vr.start_date, vr.end_date, vr.is_multi_day, vr.status, vr.assignment_letter_url, vr.is_nda_accepted, vr.notes, vr.created_at, vr.updated_at, vr.purpose_note,
    l.name AS location_name, l.type AS location_type,
    l.address AS location_address, l.city AS location_city,
    l.timezone AS location_timezone,
    v.name AS vendor_name,
    pu.name AS vendor_user_name, pu.email AS vendor_user_email, pu.phone AS vendor_user_phone
FROM visit_request vr
JOIN location l ON l.id = vr.location_id
LEFT JOIN vendor v ON v.id = vr.vendor_id
JOIN users pu ON pu.id = vr.vendor_user_id
WHERE vr.id = ANY(sqlc.arg('visit_ids')::uuid[]);

-- name: ListCheckInsByVisitIDs :many
-- Batched existence read for the R2 no-show sweep: one round trip for the
-- whole candidate set instead of one GetCheckInByVisitRequest probe per
-- visit. Rides the UNIQUE index on check_in(visit_request_id).
SELECT * FROM check_in WHERE visit_request_id = ANY(sqlc.arg('visit_request_ids')::uuid[]);
