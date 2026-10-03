-- =============================================================================
-- visits.sql - Visit request lifecycle (PRD L129-L154 state machine).
--
-- ATOMICITY CONTRACT (PRD L129)
--   Every status transition is two writes in ONE transaction: the
--   GetVisit*ForUpdate row lock, UpdateVisitStatus, and InsertStatusHistory.
--   The FOR UPDATE variants exist so a concurrent approve/check-in cannot read
--   a stale status between the read and the write.
--
-- SCOPE INVARIANT (PRD L109-112, AGENTS.md rule 6.1, rule 7.4)
--   Branch isolation is implemented as three statically-written queries - one
--   per role scope - rather than one query with a dynamic predicate. A
--   super_admin list can never accidentally carry a location filter it did not
--   intend, and an admin/security list is a hard `vr.location_id = $1`
--   equality that no caller can widen. Every scope value is a bound parameter;
--   no role name, location id or search term is ever concatenated into SQL.
--     super_admin : ListVisitsForSuperAdmin  (location_id filter is OPTIONAL)
--     admin       : ListVisitsForLocation     (location_id REQUIRED)
--     security    : ListVisitsForLocation     (location_id REQUIRED,
--                                              + date_from/date_to = TODAY, PRD L97)
--     vendor       : ListVisitsForPIC          (pic_user_id REQUIRED)
--   Each list query has a Count* twin with the identical predicate so the
--   {items,total,page,limit} envelope (openapi L896-913) cannot drift from the
--   page it is counting.
-- =============================================================================

-- name: CreateVisit :one
-- POST /visits (openapi L292-307). The human visit code is supplied by the
-- caller as 'VST-' || lpad(nextval('visit_seq'),10,'0'); the format is enforced
-- by chk_visit_request_visit_id_format. status is pinned to 'requested'
-- (PRD L133) and cannot be set by the request body.
INSERT INTO visit_request (
    visit_id, pic_user_id, vendor_id, location_id,
    start_date, end_date, is_multi_day, status,
    assignment_letter_url, is_nda_accepted, notes, purpose_note
)
VALUES ($1, $2, $3, $4, $5, $6, $7, 'requested', $8, $9, $10, $11)
RETURNING *;

-- Detail read for GET /visits/{id} (openapi L309-327) and for every
-- owner-scoped response. The projection is the visit row plus the joined names
-- the openapi VisitDetail schema needs (location, vendor_name, pic_user).
-- name: GetVisitByID :one
SELECT
    vr.*,
    l.name AS location_name, l.type AS location_type,
    l.address AS location_address, l.city AS location_city,
    l.timezone AS location_timezone,
    v.name AS vendor_name,
    pu.name AS pic_name, pu.email AS pic_email, pu.phone AS pic_phone
FROM visit_request vr
JOIN location l ON l.id = vr.location_id
LEFT JOIN vendor v ON v.id = vr.vendor_id
JOIN users pu ON pu.id = vr.pic_user_id
WHERE vr.id = $1;

-- name: GetVisitByVisitCode :one
-- Triple-Mode Scanner mode 3 (PRD L119): the guard types the printed code
-- `VST-XXXXXXXXXX` by hand. The code is UNIQUE (ERD L81) so this resolves at
-- most one visit, and idx_visit_id_code (PRD L208) makes it a single index probe.
SELECT
    vr.*,
    l.name AS location_name, l.type AS location_type,
    l.address AS location_address, l.city AS location_city,
    l.timezone AS location_timezone,
    v.name AS vendor_name,
    pu.name AS pic_name, pu.email AS pic_email, pu.phone AS pic_phone
FROM visit_request vr
JOIN location l ON l.id = vr.location_id
LEFT JOIN vendor v ON v.id = vr.vendor_id
JOIN users pu ON pu.id = vr.pic_user_id
WHERE vr.visit_id = $1;

-- name: GetVisitByIDForUpdate :one
-- Row lock for the status-write path. `FOR UPDATE OF vr` is required (not the
-- bare form) because the projection LEFT JOINs vendor, and PostgreSQL refuses
-- `FOR UPDATE` on the nullable side of an outer join.
SELECT
    vr.*,
    l.name AS location_name, l.type AS location_type,
    v.name AS vendor_name,
    pu.name AS pic_name
FROM visit_request vr
JOIN location l ON l.id = vr.location_id
LEFT JOIN vendor v ON v.id = vr.vendor_id
JOIN users pu ON pu.id = vr.pic_user_id
WHERE vr.id = $1
FOR UPDATE OF vr;

-- name: GetVisitByVisitCodeForUpdate :one
-- Same lock, entered via the scanned/manual visit code.
SELECT
    vr.*,
    l.name AS location_name, l.type AS location_type,
    v.name AS vendor_name,
    pu.name AS pic_name
FROM visit_request vr
JOIN location l ON l.id = vr.location_id
LEFT JOIN vendor v ON v.id = vr.vendor_id
JOIN users pu ON pu.id = vr.pic_user_id
WHERE vr.visit_id = $1
FOR UPDATE OF vr;

-- name: ListVisitsForSuperAdmin :many
-- Superadmin scope (PRD L109): no location filter, or one optional location
-- filter. `status`, `date_from`, `date_to` and `search` are all NULLable
-- (narg) so "no filter" is expressed by a NULL bound value, never by removing
-- a predicate at runtime.
-- ORDER BY is fully specified (id last) so LIMIT/OFFSET pagination cannot
-- repeat or drop a row.
SELECT
    vr.*,
    l.name AS location_name, l.type AS location_type, l.timezone AS location_timezone,
    v.name AS vendor_name,
    pu.name AS pic_name, pu.email AS pic_email, pu.phone AS pic_phone
FROM visit_request vr
JOIN location l ON l.id = vr.location_id
LEFT JOIN vendor v ON v.id = vr.vendor_id
JOIN users pu ON pu.id = vr.pic_user_id
WHERE (sqlc.narg('location_id')::uuid IS NULL OR vr.location_id = sqlc.narg('location_id')::uuid)
  AND (sqlc.narg('status')::text IS NULL OR vr.status = sqlc.narg('status')::text)
  AND (sqlc.narg('date_from')::timestamptz IS NULL OR vr.start_date >= sqlc.narg('date_from')::timestamptz)
  AND (sqlc.narg('date_to')::timestamptz IS NULL OR vr.start_date < sqlc.narg('date_to')::timestamptz)
  AND (
        sqlc.narg('search')::text IS NULL
     OR pu.name ILIKE '%' || sqlc.narg('search')::text || '%'
     OR vr.visit_id ILIKE '%' || sqlc.narg('search')::text || '%'
  )
ORDER BY vr.start_date DESC, vr.created_at DESC, vr.id DESC
LIMIT sqlc.arg('limit') OFFSET sqlc.arg('offset');

-- name: CountVisitsForSuperAdmin :one
-- Companion count; predicate is byte-for-byte the ListVisitsForSuperAdmin one.
SELECT count(*)
FROM visit_request vr
JOIN users pu ON pu.id = vr.pic_user_id
WHERE (sqlc.narg('location_id')::uuid IS NULL OR vr.location_id = sqlc.narg('location_id')::uuid)
  AND (sqlc.narg('status')::text IS NULL OR vr.status = sqlc.narg('status')::text)
  AND (sqlc.narg('date_from')::timestamptz IS NULL OR vr.start_date >= sqlc.narg('date_from')::timestamptz)
  AND (sqlc.narg('date_to')::timestamptz IS NULL OR vr.start_date < sqlc.narg('date_to')::timestamptz)
  AND (
        sqlc.narg('search')::text IS NULL
     OR pu.name ILIKE '%' || sqlc.narg('search')::text || '%'
     OR vr.visit_id ILIKE '%' || sqlc.narg('search')::text || '%'
  );

-- name: ListVisitsForLocation :many
-- Admin scope (PRD L110) and Security scope (PRD L111, L97). location_id is a
-- REQUIRED plain parameter - the caller cannot pass NULL, so a bug in the auth
-- middleware surfaces as a scan error instead of a cross-branch data leak.
-- The security gate is a date range on the same query: the usecase pins
-- date_from/date_to to today for `security` (PRD L97 "Hari Ini") and leaves them
-- NULL for `admin`. The equality on vr.location_id uses idx_visit_request_location.
SELECT
    vr.*,
    l.name AS location_name, l.type AS location_type, l.timezone AS location_timezone,
    v.name AS vendor_name,
    pu.name AS pic_name, pu.email AS pic_email, pu.phone AS pic_phone
FROM visit_request vr
JOIN location l ON l.id = vr.location_id
LEFT JOIN vendor v ON v.id = vr.vendor_id
JOIN users pu ON pu.id = vr.pic_user_id
WHERE vr.location_id = sqlc.arg('location_id')::uuid
  AND (sqlc.narg('status')::text IS NULL OR vr.status = sqlc.narg('status')::text)
  AND (sqlc.narg('date_from')::timestamptz IS NULL OR vr.start_date >= sqlc.narg('date_from')::timestamptz)
  AND (sqlc.narg('date_to')::timestamptz IS NULL OR vr.start_date < sqlc.narg('date_to')::timestamptz)
  AND (
        sqlc.narg('search')::text IS NULL
     OR pu.name ILIKE '%' || sqlc.narg('search')::text || '%'
     OR vr.visit_id ILIKE '%' || sqlc.narg('search')::text || '%'
  )
ORDER BY vr.start_date DESC, vr.created_at DESC, vr.id DESC
LIMIT sqlc.arg('limit') OFFSET sqlc.arg('offset');

-- name: CountVisitsForLocation :one
SELECT count(*)
FROM visit_request vr
JOIN users pu ON pu.id = vr.pic_user_id
WHERE vr.location_id = sqlc.arg('location_id')::uuid
  AND (sqlc.narg('status')::text IS NULL OR vr.status = sqlc.narg('status')::text)
  AND (sqlc.narg('date_from')::timestamptz IS NULL OR vr.start_date >= sqlc.narg('date_from')::timestamptz)
  AND (sqlc.narg('date_to')::timestamptz IS NULL OR vr.start_date < sqlc.narg('date_to')::timestamptz)
  AND (
        sqlc.narg('search')::text IS NULL
     OR pu.name ILIKE '%' || sqlc.narg('search')::text || '%'
     OR vr.visit_id ILIKE '%' || sqlc.narg('search')::text || '%'
  );

-- name: ListVisitsForPIC :many
-- PIC / external-staff scope (PRD L112, AGENTS.md rule 6.1): strictly
-- WHERE pic_user_id = auth_user.id. A vendor can never widen this to see another
-- vendor's visits, whatever they send in the query string. Uses idx_visit_pic
-- (PRD L209).
SELECT
    vr.*,
    l.name AS location_name, l.type AS location_type, l.timezone AS location_timezone,
    v.name AS vendor_name,
    pu.name AS pic_name, pu.email AS pic_email, pu.phone AS pic_phone
FROM visit_request vr
JOIN location l ON l.id = vr.location_id
LEFT JOIN vendor v ON v.id = vr.vendor_id
JOIN users pu ON pu.id = vr.pic_user_id
WHERE vr.pic_user_id = sqlc.arg('pic_user_id')::uuid
  AND (sqlc.narg('status')::text IS NULL OR vr.status = sqlc.narg('status')::text)
  AND (sqlc.narg('date_from')::timestamptz IS NULL OR vr.start_date >= sqlc.narg('date_from')::timestamptz)
  AND (sqlc.narg('date_to')::timestamptz IS NULL OR vr.start_date < sqlc.narg('date_to')::timestamptz)
  AND (
        sqlc.narg('search')::text IS NULL
     OR pu.name ILIKE '%' || sqlc.narg('search')::text || '%'
     OR vr.visit_id ILIKE '%' || sqlc.narg('search')::text || '%'
  )
ORDER BY vr.start_date DESC, vr.created_at DESC, vr.id DESC
LIMIT sqlc.arg('limit') OFFSET sqlc.arg('offset');

-- name: CountVisitsForPIC :one
SELECT count(*)
FROM visit_request vr
JOIN users pu ON pu.id = vr.pic_user_id
WHERE vr.pic_user_id = sqlc.arg('pic_user_id')::uuid
  AND (sqlc.narg('status')::text IS NULL OR vr.status = sqlc.narg('status')::text)
  AND (sqlc.narg('date_from')::timestamptz IS NULL OR vr.start_date >= sqlc.narg('date_from')::timestamptz)
  AND (sqlc.narg('date_to')::timestamptz IS NULL OR vr.start_date < sqlc.narg('date_to')::timestamptz)
  AND (
        sqlc.narg('search')::text IS NULL
     OR pu.name ILIKE '%' || sqlc.narg('search')::text || '%'
     OR vr.visit_id ILIKE '%' || sqlc.narg('search')::text || '%'
  );

-- name: UpdateVisitStatus :one
-- The single write path for every state transition in PRD L133-153 (approve,
-- reject, cancel, check-in, check-out, reschedule, worker auto-rules). Callers
-- must hold the GetVisit*ForUpdate row lock and must append an
-- InsertStatusHistory row in the same transaction (PRD L129).
-- updated_at is set here because the repository layer owns that column (see the
-- migration header).
UPDATE visit_request
SET status     = $2,
    updated_at = now()
WHERE id = $1
RETURNING *;

-- name: UpdateVisitSchedule :one
-- POST /visits/{id}/reschedule (openapi L376-404). The new window must still
-- satisfy chk_visit_request_date_order, so a reversed reschedule is rejected by
-- the database as well as by the request validation.
UPDATE visit_request
SET start_date = $2,
    end_date   = $3,
    status     = $4,
    updated_at = now()
WHERE id = $1
RETURNING *;

-- name: InsertStatusHistory :one
-- Atomic audit append (PRD L129). changed_by is NULL for the background
-- auto-rule worker, which has no acting user.
INSERT INTO status_history (visit_request_id, status, changed_by, changed_at, notes)
VALUES ($1, $2, $3, COALESCE(sqlc.narg('changed_at')::timestamptz, now()), $4)
RETURNING *;

-- name: ListStatusHistory :many
-- Status timeline on SCR-04 (openapi L832+, PRD L232).
SELECT sh.*, u.name AS changed_by_name
FROM status_history sh
LEFT JOIN users u ON u.id = sh.changed_by
WHERE sh.visit_request_id = $1
ORDER BY sh.changed_at ASC, sh.id ASC;

-- name: InsertVisitor :one
-- POST /visits visitors[] (openapi L816-822), up to 10 rows per visit (QA
-- VISIT-05). vendor_id is the technician's own company (openapi VisitorItem);
-- NULL for internal staff. vendor_name_override is the manually typed company
-- (migration 000005), stored ONLY when vendor_id is absent: a sent vendor_id
-- wins and the Go caller passes NULL for the override. Cascades to nothing on
-- insert; the visit FK is ON DELETE CASCADE so deleting a visit removes its
-- roster.
INSERT INTO visitor (visit_request_id, name, id_number, phone, id_card_photo_url, photo_url, vendor_id, vendor_name_override)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING *;

-- name: ListVisitors :many
-- Roster for SCR-04 / SCR-05. Batched per page with a single IN (...) by the
-- repository to avoid an N+1 over the visit list. The vendor name rides along
-- for the openapi VisitorItem vendor_name member.
SELECT v.*,
    vn.name AS vendor_name
FROM visitor v
LEFT JOIN vendor vn ON vn.id = v.vendor_id
WHERE v.visit_request_id = ANY(sqlc.arg('visit_request_ids')::uuid[])
ORDER BY v.created_at ASC, v.id ASC;

-- name: InsertVisitPurpose :exec
-- visit_purpose is a pure join table (ERD L107-110) whose composite primary key
-- already rejects a duplicate (visit, purpose) pair.
INSERT INTO visit_purpose (visit_request_id, purpose_id)
VALUES ($1, $2);

-- name: ListVisitPurposes :many
SELECT vp.visit_request_id, vp.purpose_id, p.name AS purpose_name, p.is_active AS purpose_is_active
FROM visit_purpose vp
JOIN purpose p ON p.id = vp.purpose_id
WHERE vp.visit_request_id = ANY(sqlc.arg('visit_request_ids')::uuid[])
ORDER BY p.name ASC;

-- name: DeleteVisit :one
-- DELETE /visits/:id (super_admin only, any status). The child tables
-- (visitor, visit_purpose, status_history, check_in, check_out) all carry
-- ON DELETE CASCADE, so removing the single visit row cleans its roster,
-- purposes, history and gate records atomically. A missing id surfaces
-- pgx.ErrNoRows (-> 404 via MapError). There is deliberately no status
-- guard: a super_admin may purge a visit in any lifecycle state.
DELETE FROM visit_request
WHERE id = $1
RETURNING id;
