-- =============================================================================
-- master.sql - Read-only master data for the pickers on SCR-03.
--
--   Both endpoints are read-only in the MVP (PRD L83: "MVP menggunakan database
--   seeding"), so there is deliberately no INSERT/UPDATE here. Rows are written
--   by the seeds program and, for locations, toggled by super_admin later.
--   The active filter matches the openapi summaries "fasilitas ... THC aktif"
--   (openapi L196) and only active purposes are offered to a PIC.
-- =============================================================================

-- name: ListActiveLocations :many
-- GET /locations (openapi L193-203) -> the Location schema (openapi L719-738).
SELECT id, name, type, address, city, timezone
FROM location
WHERE is_active = true
ORDER BY name ASC;

-- name: GetLocationByID :one
SELECT id, name, type, address, city, timezone
FROM location
WHERE id = $1;

-- name: ListActivePurposes :many
-- GET /purposes (openapi L205-215) -> the Purpose schema (openapi L750-758).
SELECT id, name
FROM purpose
WHERE is_active = true
ORDER BY name ASC;

-- name: GetActivePurposesByIDs :many
-- Resolves the CreateVisitRequest.purpose_ids array (openapi L792-798) in one
-- round trip and lets the usecase verify every id is still an active purpose
-- before inserting into visit_purpose.
SELECT id, name
FROM purpose
WHERE id = ANY(sqlc.arg('purpose_ids')::uuid[])
  AND is_active = true
ORDER BY name ASC;
