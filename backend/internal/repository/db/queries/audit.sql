-- =============================================================================
-- audit.sql - Append-only audit trail (ERD L172-182, migration 000007).
--
-- SCOPE NOTE
--   Audit rows are written by the application AFTER the authorisation check
--   has passed, so no role-scoped list variants exist here (contrast with
--   visits.sql, where branch isolation forces three statically-written list
--   queries). Read access is gated by the Go layer: super_admin may list the
--   full trail, other roles never reach these queries.
--
-- FILTER INVARIANT
--   Every filter is NULLable (narg) so "no filter" is expressed by a NULL
--   bound value, never by removing a predicate at runtime. The Count twin
--   carries the byte-for-byte identical predicate so the {items,total}
--   envelope cannot drift from the page it is counting.
-- =============================================================================

-- name: InsertAuditLog :one
-- Single append path for every auditable action. user_id is NULL for
-- system-initiated rows (background auto-rule worker, no acting user - same
-- rationale as status_history.changed_by in visits.sql InsertStatusHistory).
-- timestamp defaults to now() and is omitted from the insert so the database
-- owns the event time, not the caller clock.
INSERT INTO audit_log (user_id, action, entity, entity_id, ip, user_agent, metadata)
VALUES (
    sqlc.narg('user_id')::uuid,
    sqlc.arg('action'),
    sqlc.arg('entity'),
    sqlc.narg('entity_id')::uuid,
    sqlc.narg('ip'),
    sqlc.narg('user_agent'),
    sqlc.narg('metadata')::jsonb
)
RETURNING *;

-- name: ListAuditLogs :many
-- Filtered trail read. date_from is inclusive, date_to is exclusive (half-open
-- [from, to) window, same convention as the visits.sql list queries).
-- ORDER BY is fully specified (id last) so LIMIT/OFFSET pagination cannot
-- repeat or drop a row.
SELECT *
FROM audit_log
WHERE (sqlc.narg('user_id')::uuid IS NULL OR user_id = sqlc.narg('user_id')::uuid)
  AND (sqlc.narg('entity')::text IS NULL OR entity = sqlc.narg('entity')::text)
  AND (sqlc.narg('action')::text IS NULL OR action = sqlc.narg('action')::text)
  AND (sqlc.narg('date_from')::timestamptz IS NULL OR timestamp >= sqlc.narg('date_from')::timestamptz)
  AND (sqlc.narg('date_to')::timestamptz IS NULL OR timestamp < sqlc.narg('date_to')::timestamptz)
ORDER BY timestamp DESC, id DESC
LIMIT sqlc.arg('limit') OFFSET sqlc.arg('offset');

-- name: CountAuditLogs :one
-- Companion count; predicate is byte-for-byte the ListAuditLogs one.
SELECT count(*)
FROM audit_log
WHERE (sqlc.narg('user_id')::uuid IS NULL OR user_id = sqlc.narg('user_id')::uuid)
  AND (sqlc.narg('entity')::text IS NULL OR entity = sqlc.narg('entity')::text)
  AND (sqlc.narg('action')::text IS NULL OR action = sqlc.narg('action')::text)
  AND (sqlc.narg('date_from')::timestamptz IS NULL OR timestamp >= sqlc.narg('date_from')::timestamptz)
  AND (sqlc.narg('date_to')::timestamptz IS NULL OR timestamp < sqlc.narg('date_to')::timestamptz);
