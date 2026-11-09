-- =============================================================================
-- user_locations.sql - Branch-coverage union for multi-branch scoping.
--
-- Hybrid primary+coverage architecture (migration 000023): users.location_id
-- stays the primary assignment forever; user_locations is the single source
-- of scope truth for admin/security branch unions. The backfill seeded the
-- table; the account writes (InsertSecurityUser, InsertManagedUser,
-- UpdateManagedUser) maintain it in the same transaction as the primary, so
-- the two stores can never skew. No read lives beside another read's query:
-- the scope SELECT stays above, the write legs below.
-- =============================================================================

-- name: ListUserLocationIDs :many
-- Per-request scope resolution for the JWT middleware: the branch union of
-- one user, ordered for determinism. An empty result is a real answer (no
-- coverage), never NULL: sqlc emits an empty slice so callers fail closed.
SELECT location_id
FROM user_locations
WHERE user_id = $1
ORDER BY location_id ASC;

-- name: ListUserLocationsByUserIDs :many
-- Batched coverage load for the account listings (ListManagedUsers,
-- ListSecurityUsers): one round trip for the whole page instead of N+1
-- per-user lookups. Rows arrive ordered by user then branch so the Go layer
-- can regroup deterministically and force the primary first.
SELECT user_id, location_id
FROM user_locations
WHERE user_id = ANY(sqlc.arg('user_ids')::uuid[])
ORDER BY user_id ASC, location_id ASC;

-- name: InsertUserLocation :exec
-- Dual-write leg of the account creates and updates: one coverage row for
-- the effective primary (the first location_ids element, else the legacy
-- location_id). Creates call it once; updates call it after the delete
-- below, so the union is exactly the primary after every write.
INSERT INTO user_locations (user_id, location_id)
VALUES ($1, $2);

-- name: DeleteUserLocationsByUserID :exec
-- Dual-write leg of the account updates (delete-then-insert): clears the
-- stale coverage before the effective primary is re-inserted above. A keep
-- (NULL patch) re-inserts the stored primary, so the union is rewritten
-- identically instead of drifting.
DELETE FROM user_locations
WHERE user_id = $1;
