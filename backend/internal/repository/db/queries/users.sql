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
-- empty string so `"location_id": null` is emitted for super_admin/vendor.
-- name: GetUserByEmailForLogin :one
SELECT
    u.id,
    u.name,
    u.email,
    u.password_hash,
    u.phone,
    u.nik,
    u.role_id,
    r.name AS role,
    u.location_id,
    l.name AS location_name,
    u.status,
    u.type,
    v.name AS vendor_name,
    u.vendor_id,
    u.vendor_name_override
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
    u.nik,
    u.role_id,
    r.name AS role,
    u.location_id,
    l.name AS location_name,
    u.status,
    u.type,
    v.name AS vendor_name,
    u.vendor_id,
    u.vendor_name_override,
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
RETURNING id, name, email, phone, nik, role_id, location_id, type, status, created_at, updated_at;

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
    u.nik,
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
RETURNING id, name, email, phone, nik, role_id, location_id, type, status, created_at, updated_at;

-- =============================================================================
-- SUPER_ADMIN MANAGED ACCOUNTS (PRD §4: kelola admin/vendor + security semua
-- cabang). Same bound-parameter scoping invariant as above: role, search and
-- location_id are NULLable bound values, never interpolated SQL text.
-- =============================================================================

-- GET /users (super_admin only). role narrows to one of admin|vendor|security
-- (validated in Go before this runs); search matches nama atau email
-- case-insensitively; location_id narrows to one branch. All three filters
-- are optional, so an empty filter lists every account with no pagination,
-- consistent with ListSecurityUsers. ORDER BY keeps the listing stable.
-- name: ListManagedUsers :many
SELECT
    u.id,
    u.name,
    u.email,
    u.phone,
    u.nik,
    r.name AS role,
    u.location_id,
    l.name AS location_name,
    u.status,
    u.type,
    v.name AS vendor_name,
    u.vendor_id,
    u.vendor_name_override,
    u.created_at
FROM users u
JOIN role r ON r.id = u.role_id
LEFT JOIN location l ON l.id = u.location_id
LEFT JOIN vendor v ON v.id = u.vendor_id
WHERE (sqlc.narg('role')::text IS NULL OR r.name = sqlc.narg('role')::text)
  AND (sqlc.narg('search')::text IS NULL
       OR u.name ILIKE '%' || sqlc.narg('search')::text || '%'
       OR u.email ILIKE '%' || sqlc.narg('search')::text || '%')
  AND (sqlc.narg('location_id')::uuid IS NULL OR u.location_id = sqlc.narg('location_id')::uuid)
ORDER BY u.created_at DESC, u.id DESC;

-- POST /users (super_admin only). Unlike InsertSecurityUser this insert takes
-- type, status and vendor_id as parameters: admin rows are type 'internal'
-- with a branch location, vendor rows are type 'external' with no location and
-- an optional vendor. The enforce_user_location_invariant trigger rejects any
-- pairing the Go validation missed (check_violation -> 400 via MapError) and
-- users_email_key rejects a duplicate email (23505 -> 409 via MapError).
-- name: InsertManagedUser :one
INSERT INTO users (name, email, password_hash, phone, nik, role_id, location_id, type, status, vendor_id, vendor_name_override)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
RETURNING id, name, email, phone, nik, role_id, location_id, type, status, vendor_id, vendor_name_override, created_at, updated_at;

-- Detail read for PATCH /users/{id}/status (super_admin only). Same
-- projection as GetUserByID plus the resolved role NAME, which the status
-- guard needs to refuse touches on other super_admin accounts.
-- name: GetManagedUserByID :one
SELECT
    u.id,
    u.name,
    u.email,
    u.phone,
    u.nik,
    u.role_id,
    r.name AS role,
    u.location_id,
    l.name AS location_name,
    u.status,
    u.type,
    v.name AS vendor_name,
    u.vendor_id,
    u.vendor_name_override,
    u.created_at
FROM users u
JOIN role r ON r.id = u.role_id
LEFT JOIN location l ON l.id = u.location_id
LEFT JOIN vendor v ON v.id = u.vendor_id
WHERE u.id = $1;

-- =============================================================================
-- SUPER_ADMIN HARD DELETE (DELETE /users/:id, super_admin only). The Go layer
-- runs the Count* pre-checks below FIRST and refuses with 409 while a visit,
-- gate record or history row still references the account; the DELETE itself
-- is the second line of defence (a raced reference surfaces as 23503 -> 409
-- via MapError). There is no status transition here: the row is removed.
-- =============================================================================

-- name: CountVisitsByVendorUser :one
-- DELETE /users/:id pre-check 1: visits owned by the account as vendor user
-- (visit_request.vendor_user_id, no cascade, so a remaining row blocks the delete).
SELECT count(*)
FROM visit_request
WHERE vendor_user_id = $1;

-- name: CountStaffReferences :one
-- DELETE /users/:id pre-check 2: gate and audit rows written BY the account
-- as staff (check_in.checked_in_by, check_out.checked_out_by,
-- status_history.changed_by, all without cascade). A non-zero total blocks
-- the delete with 409.
SELECT
    (SELECT count(*) FROM check_in WHERE checked_in_by = $1) +
    (SELECT count(*) FROM check_out WHERE checked_out_by = $1) +
    (SELECT count(*) FROM status_history WHERE changed_by = $1);

-- name: DeleteUser :one
-- DELETE /users/:id (super_admin only). A missing id surfaces pgx.ErrNoRows
-- (-> 404 via MapError); a raced reference surfaces 23503 (-> 409).
DELETE FROM users
WHERE id = $1
RETURNING id;

-- =============================================================================
-- SUPER_ADMIN ACCOUNT EDIT (PATCH /users/:id, super_admin only). Partial
-- update via COALESCE like UpdateLocation in master.sql: a NULL member keeps
-- the stored column, so the body may carry any subset of name, email, phone,
-- location_id, vendor_id and password (a non-empty password resets the
-- bcrypt hash; guarded by the superadmin self/other-superadmin rules).
-- Role, type and status are NEVER writable here (role is immutable, status
-- via .../status); the location invariant trigger still guards every pairing
-- (check_violation -> 400) and users_email_key guards email (23505 -> 409).
-- =============================================================================

-- name: UpdateManagedUser :one
UPDATE users
SET name          = COALESCE(sqlc.narg('name'), name),
    email         = COALESCE(sqlc.narg('email'), email),
    phone         = COALESCE(sqlc.narg('phone'), phone),
    nik           = COALESCE(sqlc.narg('nik'), nik),
    location_id   = COALESCE(sqlc.narg('location_id')::uuid, location_id),
    vendor_id     = COALESCE(sqlc.narg('vendor_id')::uuid, vendor_id),
    -- Manual-company tri-state (migration 000005): has_vendor_name_override
    -- is always sent (never NULL). false keeps the stored override (COALESCE
    -- path unreachable); true writes the nullable vendor_name_override value,
    -- so NULL clears it to SQL NULL and a text sets it. COALESCE cannot
    -- express clear-vs-keep on one nullable param, hence the explicit flag.
    vendor_name_override = CASE
        WHEN sqlc.arg('has_vendor_name_override')::boolean
        THEN sqlc.narg('vendor_name_override')
        ELSE vendor_name_override
    END,
    password_hash = COALESCE(sqlc.narg('password_hash'), password_hash),
    updated_at    = now()
WHERE id = sqlc.arg('id')
RETURNING id, name, email, phone, nik, role_id, location_id, type, status, vendor_id, vendor_name_override, created_at, updated_at;
