-- =============================================================================
-- checkin.sql - Security gate check-in (SCR-05, openapi L459-487).
--
-- DOUBLE CHECK-IN IS PHYSICALLY IMPOSSIBLE
--   check_in.visit_request_id carries UNIQUE (ERD L123 "1 visit = 1 check-in
--   record"). The INSERT below therefore has NO "ON CONFLICT" clause on purpose:
--   a second check-in for the same visit raises SQLSTATE 23505 and aborts the
--   whole transaction, including the companion visit_request status write to
--   'visiting'. Silently swallowing the conflict would let a badge be issued
--   twice. openapi L486 expects a 4xx, not a 200.
--
-- DUAL-ROLE EXECUTION (PRD L115, AGENTS.md rule 6.3)
--   checked_in_by is whatever staff id the JWT carries - the usecase accepts
--   both `security` and the branch `admin`, and the caller has already proved
--   location ownership via GetVisitByIDForUpdate + the auth location_id.
-- =============================================================================

-- name: InsertCheckIn :one
INSERT INTO check_in (visit_request_id, checked_in_at, checked_in_by, photo_url, badge_code)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: GetCheckInByVisitRequest :one
-- Existence + fact read used by the auto-rule worker (SweepNoShowApprovedVisits)
-- and by SCR-05 to render the "Sedang di Lokasi" badge. pgx reports a missing
-- row as pgx.ErrNoRows, which is the existence check.
SELECT * FROM check_in WHERE visit_request_id = $1;

-- name: ExistsCheckIn :one
-- Boolean form of the same check, for call sites that only need the flag.
SELECT EXISTS (SELECT 1 FROM check_in WHERE visit_request_id = $1)::bool AS exists;
