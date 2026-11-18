-- =============================================================================
-- visit_logs.sql - Multi-entry permit entry timeline (plan
-- .omo/plans/multi-entry-permit.md section 4, migration 000033).
--
-- One row per gate entry: check-in writes direction 'in', check-out writes
-- 'out'. The writer is the Wave-2 UpdateStatus path, which inserts the log
-- row in the SAME transaction as the status move, so a log row can never
-- exist without its status edge and vice versa. Readers order by
-- (created_at, id): created_at carries the timeline, id breaks same-instant
-- ties deterministically.
-- =============================================================================

-- name: InsertVisitLog :one
INSERT INTO visit_logs (visit_request_id, direction, actor_user_id, actor_role)
VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: ListVisitLogsByVisit :many
SELECT *
FROM visit_logs
WHERE visit_request_id = $1
ORDER BY created_at ASC, id ASC;
