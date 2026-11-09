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
-- Same shape as GetCheckInByVisitRequest: the users LEFT JOIN rides the
-- display name of the acting staff for the GET /visits/{id} "Check-out oleh"
-- row (the read path used to drop the actor entirely).
SELECT co.*, u.name AS checked_out_by_name
FROM check_out co
LEFT JOIN users u ON u.id = co.checked_out_by
WHERE co.visit_request_id = $1;

-- name: ExistsCheckOut :one
SELECT EXISTS (SELECT 1 FROM check_out WHERE visit_request_id = $1)::bool AS exists;
