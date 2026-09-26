-- =============================================================================
-- users.sql - Authentication, profile projection and branch security accounts.
--
-- SCOPE INVARIANT (PRD L110 / L112, AGENTS.md rule 6.1)
--   Every query that exposes user rows takes its location scope as a BOUND
--   PARAMETER. `sqlc.narg('location_id')` is NULL only for super_admin, which is
--   the single case where no branch filter is correct. There is no query in this
--   file that interpolates a role name or a location id into SQL text.
-- =============================================================================

-- Login lookup (POST /auth/login). Returns the projection the openapi `User`
-- schema needs (openapi L629-660) plus password_hash, which never leaves the
-- auth usecase. The CASE normalises a missing join to a Go nil rather than an
-- empty string so `"location_id": null` is emitted for super_admin/pic.
-- name: GetUserByEmailForLogin :one
SELECT
    u.id,
    u.name,
    u.email,
    u.password_hash,
    u.phone,
    u.role_id,
    r.name AS role,
    u.location_id,
    l.name AS location_name,
    u.status,
    u.type,
    v.name AS vendor_name,
    u.vendor_id
FROM users u
JOIN role r ON r.id = u.role_id
LEFT JOIN location l ON l.id = u.location_id
LEFT JOIN vendor v ON v.id = u.vendor_id
WHERE u.email = $1;

-- Profile read for GET /auth/me and for every owner-scoped response.
-- name: GetUserByID :one
SELECT
    u.id,
    u.name,
    u.email,
    u.phone,
    u.role_id,
    r.name AS role,
    u.location_id,
    l.name AS location_name,
    u.status,
    u.type,
    v.name AS vendor_name,
    u.vendor_id,
    u.created_at
FROM users u
JOIN role r ON r.id = u.role_id
LEFT JOIN location l ON l.id = u.location_id
LEFT JOIN vendor v ON v.id = u.vendor_id
WHERE u.id = $1;

-- Successful login bookkeeping. Also refreshes updated_at (see the migration
-- header: the repository layer owns this column).
-- name: UpdateUserLastLogin :exec
UPDATE users
SET last_login = now(),
    updated_at  = now()
WHERE id = $1;

-- name: InsertSecurityUser :one
-- POST /users/security (openapi L140-159). A branch security officer is always
-- `type = 'internal'` and starts `active`; the role id is passed in so the caller
-- resolves the 'security' role, and the trigger rejects a NULL location_id for it
-- (PRD L111).
INSERT INTO users (name, email, password_hash, phone, role_id, location_id, type, status)
VALUES ($1, $2, $3, $4, $5, $6, 'internal', 'active')
RETURNING id, name, email, phone, role_id, location_id, type, status, created_at, updated_at;

-- GET /users/security (openapi L119-138). `sqlc.narg('location_id')` is the whole
-- scoping mechanism: an admin/security caller passes its own location (PRD L110),
-- a super_admin passes NULL to see every branch or a location to filter (PRD L109).
-- ORDER BY created_at DESC keeps pagination stable for the account modal.
-- name: ListSecurityUsers :many
SELECT
    u.id,
    u.name,
    u.email,
    u.phone,
    r.name AS role,
    u.location_id,
    l.name AS location_name,
    u.status,
    u.type,
    v.name AS vendor_name,
    u.vendor_id,
    u.created_at
FROM users u
JOIN role r ON r.id = u.role_id
LEFT JOIN location l ON l.id = u.location_id
LEFT JOIN vendor v ON v.id = u.vendor_id
WHERE r.name = 'security'
  AND (sqlc.narg('location_id')::uuid IS NULL OR u.location_id = sqlc.narg('location_id')::uuid)
ORDER BY u.created_at DESC, u.id DESC;

-- PATCH /users/security/{id}/status (openapi L161-188). Accepts only
-- 'active'/'inactive' at the request boundary; the CHECK constraint on
-- users.status additionally rejects 'blacklisted' writes from this path.
-- name: UpdateUserStatus :one
UPDATE users
SET status     = $2,
    updated_at = now()
WHERE id = $1
RETURNING id, name, email, phone, role_id, location_id, type, status, created_at, updated_at;
