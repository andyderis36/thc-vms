-- =============================================================================
-- master.sql - Master data for the pickers on SCR-03 plus the super_admin
-- facility writes (PRD §4: kelola lokasi).
--
--   The SCR-03 pickers stay read-only (PRD L83: "MVP menggunakan database
--   seeding"): rows are written by the seeds program and read through the
--   List/Get queries below. The super_admin CRUD is append-only in the write
--   direction: INSERT (POST /locations) and partial UPDATE
--   (PATCH /locations/:id). There is deliberately no DELETE: location rows
--   are referenced by visits.location_id and users.location_id (restrict
--   FKs), and the MVP has no restore flow, so deactivation via is_active is
--   the only removal (YAGNI).
--   The active filter matches the openapi summaries "fasilitas ... THC aktif"
--   (openapi L196) and only active purposes are offered to a vendor user.
-- =============================================================================

-- name: ListActiveLocations :many
-- GET /locations (openapi L193-203) -> the Location schema (openapi L719-738).
-- The ?active_only=true (default) path: only facilities still operating are
-- offered, which is what the SCR-03 visit form consumes.
SELECT id, name, type, address, city, timezone
FROM location
WHERE is_active = true
ORDER BY name ASC;

-- name: ListAllLocations :many
-- GET /locations?active_only=false (super_admin console only): every
-- facility row including deactivated ones, so a switched-off branch stays
-- visible and can be reactivated via PATCH /locations/:id. Same column
-- shape plus the is_active flag the console renders.
SELECT id, name, type, address, city, timezone, is_active
FROM location
ORDER BY name ASC;

-- name: GetLocationByID :one
SELECT id, name, type, address, city, timezone, is_active
FROM location
WHERE id = $1;

-- name: ListActivePurposes :many
-- GET /purposes (openapi L205-215) -> the Purpose schema (openapi L750-758).
SELECT id, name
FROM purpose
WHERE is_active = true
ORDER BY name ASC;

-- name: ListActiveVendors :many
-- GET /vendors -> the [{id, name}] company dropdown the vendor-user/admin forms
-- consume. Only non-blacklisted companies are offered, mirroring the
-- active-only purpose catalogue above.
SELECT id, name
FROM vendor
WHERE is_blacklisted = false
ORDER BY name ASC;

-- name: GetVendorName :one
-- Resolves one company name for the auth profile (GET /auth/me + login
-- response vendor_name). A missing id surfaces pgx.ErrNoRows (-> 404 via
-- MapError); callers that tolerate absence check for it explicitly.
SELECT name
FROM vendor
WHERE id = $1;

-- name: GetActivePurposesByIDs :many
-- Resolves the CreateVisitRequest.purpose_ids array (openapi L792-798) in one
-- round trip and lets the usecase verify every id is still an active purpose
-- before inserting into visit_purpose.
SELECT id, name
FROM purpose
WHERE id = ANY(sqlc.arg('purpose_ids')::uuid[])
  AND is_active = true
ORDER BY name ASC;

-- =============================================================================
-- SUPER_ADMIN FACILITY WRITES (PRD §4: kelola lokasi). New facilities start
-- active; the soft removal stays deactivation via is_active, while the hard
-- removal is DELETE /locations/:id (super_admin only, with the Count*
-- pre-checks below refusing with 409 while users or visits still reference
-- the row; the DELETE itself is the second line of defence, 23503 -> 409).
-- =============================================================================

-- name: InsertLocation :one
-- POST /locations (super_admin only). timezone defaults to 'WIB' in Go before
-- this runs; the chk_location_type / chk_location_timezone CHECKs are the
-- second line of defence (23514 -> 400 via MapError).
INSERT INTO location (name, type, address, city, timezone, is_active)
VALUES ($1, $2, $3, $4, $5, true)
RETURNING id, name, type, address, city, timezone, is_active;

-- name: UpdateLocation :one
-- PATCH /locations/:id (super_admin only). Every column is a NULLable bound
-- value: a NULL keeps the stored column via COALESCE, so the body may carry
-- any subset of fields. is_active flips here are the deactivation path that
-- replaces DELETE.
UPDATE location
SET name      = COALESCE(sqlc.narg('name'), name),
    type      = COALESCE(sqlc.narg('type'), type),
    address   = COALESCE(sqlc.narg('address'), address),
    city      = COALESCE(sqlc.narg('city'), city),
    timezone  = COALESCE(sqlc.narg('timezone'), timezone),
    is_active = COALESCE(sqlc.narg('is_active')::boolean, is_active)
WHERE id = $1
RETURNING id, name, type, address, city, timezone, is_active;

-- name: CountUsersByLocation :one
-- DELETE /locations/:id pre-check 1: accounts stationed at the facility
-- (users.location_id, no cascade, so a remaining row blocks the delete).
SELECT count(*)
FROM users
WHERE location_id = $1;

-- name: CountVisitsByLocation :one
-- DELETE /locations/:id pre-check 2: visits hosted at the facility
-- (visit_request.location_id, no cascade, so a remaining row blocks it).
SELECT count(*)
FROM visit_request
WHERE location_id = $1;

-- name: DeleteLocation :one
-- DELETE /locations/:id (super_admin only). A missing id surfaces
-- pgx.ErrNoRows (-> 404 via MapError); a raced reference surfaces 23503
-- (-> 409).
DELETE FROM location
WHERE id = $1
RETURNING id;
