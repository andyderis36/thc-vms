-- =============================================================================
-- worker.sql - Auto-rule background sweeps (PRD L48-57 "Auto-Rule Background
-- Worker", PRD L133-153 state machine, PRD L137 / L142 / L148).
--
-- CONTRACT
--   Each sweep is a SELECT that RETURNS the affected visit ids and does NOT
--   mutate anything. The worker then, inside the SAME transaction per batch:
--     1. runs the sweep        -> the rows are already locked, so the ids cannot
--                                be re-selected by a second worker instance;
--     2. UpdateVisitStatus     -> requested->cancelled (R1) |
--                                approved->cancelled (R2) |
--                                visiting|offsite->completed (R3);
--     3. InsertStatusHistory   -> changed_by = NULL, notes = the rule id.
--   Keeping the mutation out of the query file is what lets the caller batch the
--   whole sweep into one atomic, auditable transaction (PRD L129).
--
--   FOR UPDATE ... SKIP LOCKED is mandatory: a single-tick sweeper must not block
--   on - or double-process - rows another instance is already migrating.
--
-- R1  requested with a started window   -> cancelled   (start_date <= now(), never approved)
-- R2  approved | rescheduled, end datetime reached,
--     never checked in; requested once it
--     leaves R1's 2h end guard            -> cancelled   (plan §7: unused permit)
-- R3  visiting | offsite, end datetime reached
--                                       -> completed   (plan §7: permit fully used)
--
-- R2 and R3 both fire at the exact end datetime: no 2-hour grace and no
-- 24-hour delay. Thresholds(now) returns (now, now) and the Go re-checks in
-- autorule_repository.go mirror these predicates exactly.
--
-- R1 keeps its original start_date <= now() predicate and its end_date >
-- now()-2h guard, so a requested visit whose window closed inside that guard
-- stays R1's. R2 therefore claims a requested visit only once end_date <=
-- now()-2h (the guard's complement), which keeps the two rules disjoint on
-- end_date for the requested status and sweeps the requests R1 can no longer
-- reach. Rescheduled permits are R2's unconditionally at end.
-- =============================================================================

-- name: SweepStaleRequestedVisits :many
-- R1: a request still unanswered once its visit window has started (start_date
-- <= now()) is abandoned. The end_date > now()-2h guard is retained verbatim
-- from the prior split; R2's requested branch is its exact complement, so the
-- two sweeps are disjoint on end_date for requested rows.
-- Capped at 500 rows per tick (S4): one sweep locks and migrates at most one
-- batch, never the whole table.
SELECT vr.id, vr.visit_id, vr.status, vr.vendor_user_id, vr.location_id, vr.start_date, vr.end_date
FROM visit_request vr
WHERE vr.status = 'requested'
  AND vr.start_date <= now()
  AND vr.end_date > now() - interval '2 hours'
ORDER BY vr.start_date ASC
LIMIT 500
FOR UPDATE OF vr SKIP LOCKED;

-- name: SweepNoShowVisits :many
-- R2: a permit whose end datetime has arrived with no check_in row and which
-- never became an entry (plan §7: a permit never entered is an unused permit
-- -> cancelled). Covers every pre-arrival status: approved and rescheduled
-- unconditionally at end, requested only once R1's 2h end guard has also
-- expired (end_date <= now()-2h) so the two sweeps never claim the same
-- requested row. Uses idx_visit_status for the status scan and the UNIQUE
-- index on check_in(visit_request_id) for the anti-join probe. Visiting and
-- offsite rows are NOT listed here: they belong to R3. Capped at 500 rows per
-- tick (S4).
SELECT vr.id, vr.visit_id, vr.status, vr.vendor_user_id, vr.location_id, vr.start_date, vr.end_date
FROM visit_request vr
WHERE vr.end_date <= now()
  AND (
    vr.status IN ('approved', 'rescheduled')
    OR (vr.status = 'requested' AND vr.end_date <= now() - interval '2 hours')
  )
  AND NOT EXISTS (SELECT 1 FROM check_in ci WHERE ci.visit_request_id = vr.id)
ORDER BY vr.end_date ASC
LIMIT 500
FOR UPDATE OF vr SKIP LOCKED;

-- name: SweepStaleVisitingVisits :many
-- R3: still on site (visiting or offsite) at the exact end datetime (plan §7:
-- a permit with at least one entry is completed when its window closes). No
-- +24h delay. idx_visit_date does not cover end_date, so this sweep relies on
-- the status index plus the row count of a single tick's window - deliberately
-- not adding a 5th index beyond the four PRD L206-209 mandates, since the
-- sweep runs once per tick. Capped at 500 rows per tick (S4).
SELECT vr.id, vr.visit_id, vr.status, vr.vendor_user_id, vr.location_id, vr.start_date, vr.end_date
FROM visit_request vr
WHERE vr.status IN ('visiting', 'offsite')
  AND vr.end_date <= now()
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
    vr.id, vr.visit_id, vr.vendor_user_id, vr.vendor_id, vr.location_id, vr.start_date, vr.end_date, vr.is_multi_day, vr.status, vr.assignment_letter_url, vr.is_nda_accepted, vr.notes, vr.created_at, vr.updated_at, vr.purpose_note, vr.vendor_name_override,
    l.name AS location_name, l.type AS location_type,
    l.address AS location_address, l.city AS location_city,
    l.timezone AS location_timezone,
    v.name AS vendor_name,
    pu.name AS vendor_user_name, pu.email AS vendor_user_email, pu.phone AS vendor_user_phone,
    COALESCE(pu.vendor_name_override, vu.name, '') AS vendor_user_vendor_name
FROM visit_request vr
JOIN location l ON l.id = vr.location_id
LEFT JOIN vendor v ON v.id = vr.vendor_id
JOIN users pu ON pu.id = vr.vendor_user_id
LEFT JOIN vendor vu ON vu.id = pu.vendor_id
WHERE vr.id = ANY(sqlc.arg('visit_ids')::uuid[]);

-- name: ListCheckInsByVisitIDs :many
-- Batched existence read for the R2 no-show sweep: one round trip for the
-- whole candidate set instead of one GetCheckInByVisitRequest probe per
-- visit. Rides the UNIQUE index on check_in(visit_request_id).
SELECT * FROM check_in WHERE visit_request_id = ANY(sqlc.arg('visit_request_ids')::uuid[]);
