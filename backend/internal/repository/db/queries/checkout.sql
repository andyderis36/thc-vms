-- =============================================================================
-- checkout.sql - Security gate check-out (SCR-05, openapi L489-503).
--
--   Mirrors checkin.sql: UNIQUE (visit_request_id) (ERD L132 "1 visit = 1
--   check-out record") and NO "ON CONFLICT", so a duplicate check-out is a hard
--   SQLSTATE 23505 rather than a silent no-op. The same transaction also writes
--   visit_request.status = 'completed' and appends a status_history row
--   (PRD L147, PRD L129).
-- =============================================================================

-- name: InsertCheckOut :one
INSERT INTO check_out (visit_request_id, checked_out_at, checked_out_by)
VALUES ($1, $2, $3)
RETURNING *;

-- name: GetCheckOutByVisitRequest :one
SELECT * FROM check_out WHERE visit_request_id = $1;

-- name: ExistsCheckOut :one
SELECT EXISTS (SELECT 1 FROM check_out WHERE visit_request_id = $1)::bool AS exists;
