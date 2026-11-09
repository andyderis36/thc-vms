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
--   per role scope - rather than one query with a dynamic predicate. The branch
--   and super_admin pairs share the union predicate
--   `(is_global OR location_id = ANY(location_ids))`: the resolver stash behind
--   thc.scope decides the scope, the query only enforces it. A global caller
--   passes is_global TRUE with an empty union and sees every branch; a branch
--   caller passes its user_locations union with is_global FALSE and sees
--   exactly those branches; an empty union with FALSE matches no row
--   (fail-closed, never the whole table). Every scope value is a bound
--   parameter; no role name, location id or search term is ever concatenated
--   into SQL.
--     super_admin : ListVisitsForSuperAdmin  (is_global TRUE, or a single-id
--                                              union to narrow by branch)
--     admin       : ListVisitsForLocation     (union REQUIRED, is_global FALSE
--                                              unless the stash says global)
--     security    : ListVisitsForLocation     (same union,
--                                              + date_from/date_to = TODAY, PRD L97)
--     vendor       : ListVisitsForVendorUser          (vendor_user_id REQUIRED)
--   Each list query has a Count* twin with the identical predicate so the
--   {items,total,page,limit} envelope (openapi L896-913) cannot drift from the
--   page it is counting.
-- =============================================================================

-- name: CreateVisit :one
-- POST /visits (openapi L292-307). The human visit code is supplied by the
-- caller as 'VST-' || lpad(nextval('visit_seq'),10,'0'); the format is enforced
-- by chk_visit_request_visit_id_format. status is pinned to 'requested'
-- (PRD L133) and cannot be set by the request body.
-- vendor_user_id is the vendor ACCOUNT owning the visit (chosen by an
-- admin/superadmin, or the actor itself for a vendor caller); created_by is
-- ALWAYS the authenticated actor that submitted the row (migration 000024).
INSERT INTO visit_request (
    visit_id, vendor_user_id, vendor_id, location_id,
    start_date, end_date, is_multi_day, status,
    assignment_letter_url, is_nda_accepted, notes, purpose_note,
    vendor_name_override, created_by
)
VALUES ($1, $2, $3, $4, $5, $6, $7, 'requested', $8, $9, $10, $11, $12, $13)
RETURNING *;

-- Detail read for GET /visits/{id} (openapi L309-327) and for every
-- owner-scoped response. The projection is the visit row plus the joined names
-- the openapi VisitDetail schema needs (location, vendor_name, vendor_user).
-- name: GetVisitByID :one
-- The users/role LEFT JOINs ride the creator display data for the
-- GET /visits/{id} "Diajukan oleh" row (created_by is NULL on rows written
-- before migration 000024, hence LEFT JOIN and NULL-safe output columns).
SELECT
    vr.*,
    l.name AS location_name, l.type AS location_type,
    l.address AS location_address, l.city AS location_city,
    l.timezone AS location_timezone,
    v.name AS vendor_name,
    pu.name AS vendor_user_name, pu.email AS vendor_user_email, pu.phone AS vendor_user_phone,
    COALESCE(pu.vendor_name_override, vu.name, '') AS vendor_user_vendor_name,
    cb.name AS created_by_name, cr.name AS created_by_role_name
FROM visit_request vr
JOIN location l ON l.id = vr.location_id
LEFT JOIN vendor v ON v.id = vr.vendor_id
JOIN users pu ON pu.id = vr.vendor_user_id
LEFT JOIN vendor vu ON vu.id = pu.vendor_id
LEFT JOIN users cb ON cb.id = vr.created_by
LEFT JOIN role cr ON cr.id = cb.role_id
WHERE vr.id = $1;

-- name: GetVisitByVisitCode :one
-- Triple-Mode Scanner mode 3 (PRD L119): the guard types the printed code
-- `VST-XXXXXXXXXX` by hand. The code is UNIQUE (ERD L81) so this resolves at
-- most one visit, and idx_visit_id_code (PRD L208) makes it a single index probe.
-- The creator join mirrors GetVisitByID so both single-visit read paths carry
-- the "Diajukan oleh" display data.
SELECT
    vr.*,
    l.name AS location_name, l.type AS location_type,
    l.address AS location_address, l.city AS location_city,
    l.timezone AS location_timezone,
    v.name AS vendor_name,
    pu.name AS vendor_user_name, pu.email AS vendor_user_email, pu.phone AS vendor_user_phone,
    COALESCE(pu.vendor_name_override, vu.name, '') AS vendor_user_vendor_name,
    cb.name AS created_by_name, cr.name AS created_by_role_name
FROM visit_request vr
JOIN location l ON l.id = vr.location_id
LEFT JOIN vendor v ON v.id = vr.vendor_id
JOIN users pu ON pu.id = vr.vendor_user_id
LEFT JOIN vendor vu ON vu.id = pu.vendor_id
LEFT JOIN users cb ON cb.id = vr.created_by
LEFT JOIN role cr ON cr.id = cb.role_id
WHERE vr.visit_id = $1;

-- name: GetVisitByIDForUpdate :one
-- Row lock for the status-write path. `FOR UPDATE OF vr` is required (not the
-- bare form) because the projection LEFT JOINs vendor, and PostgreSQL refuses
-- `FOR UPDATE` on the nullable side of an outer join.
SELECT
    vr.*,
    l.name AS location_name, l.type AS location_type,
    v.name AS vendor_name,
    pu.name AS vendor_user_name,
    COALESCE(pu.vendor_name_override, vu.name, '') AS vendor_user_vendor_name
FROM visit_request vr
JOIN location l ON l.id = vr.location_id
LEFT JOIN vendor v ON v.id = vr.vendor_id
JOIN users pu ON pu.id = vr.vendor_user_id
LEFT JOIN vendor vu ON vu.id = pu.vendor_id
WHERE vr.id = $1
FOR UPDATE OF vr;

-- name: GetVisitByVisitCodeForUpdate :one
-- Same lock, entered via the scanned/manual visit code.
SELECT
    vr.*,
    l.name AS location_name, l.type AS location_type,
    v.name AS vendor_name,
    pu.name AS vendor_user_name,
    COALESCE(pu.vendor_name_override, vu.name, '') AS vendor_user_vendor_name
FROM visit_request vr
JOIN location l ON l.id = vr.location_id
LEFT JOIN vendor v ON v.id = vr.vendor_id
JOIN users pu ON pu.id = vr.vendor_user_id
LEFT JOIN vendor vu ON vu.id = pu.vendor_id
WHERE vr.visit_id = $1
FOR UPDATE OF vr;

-- name: ListVisitsForSuperAdmin :many
-- Superadmin scope (PRD L109): the national view passes is_global TRUE with
-- an empty union; narrowing by branch passes that single branch as a one-id
-- union with is_global FALSE. `status`, `date_from`, `date_to` and `search`
-- are all NULLable (narg) so "no filter" is expressed by a NULL bound value,
-- never by removing a predicate at runtime. sort_by/sort_order ride along as
-- bound parameters compared inside static CASE branches (never concatenated):
-- an unknown or NULL value matches no branch and the listing falls back to
-- created_at desc. ORDER BY is fully specified (id last) so LIMIT/OFFSET
-- pagination cannot repeat or drop a row.
SELECT
    vr.*,
    l.name AS location_name, l.type AS location_type, l.timezone AS location_timezone,
    v.name AS vendor_name,
    pu.name AS vendor_user_name, pu.email AS vendor_user_email, pu.phone AS vendor_user_phone,
    COALESCE(pu.vendor_name_override, vu.name, '') AS vendor_user_vendor_name
FROM visit_request vr
JOIN location l ON l.id = vr.location_id
LEFT JOIN vendor v ON v.id = vr.vendor_id
JOIN users pu ON pu.id = vr.vendor_user_id
LEFT JOIN vendor vu ON vu.id = pu.vendor_id
WHERE (sqlc.arg('is_global')::bool OR vr.location_id = ANY(sqlc.arg('location_ids')::uuid[]))
  AND (sqlc.narg('status')::text IS NULL OR vr.status = sqlc.narg('status')::text)
  AND (sqlc.narg('date_from')::timestamptz IS NULL OR vr.start_date >= sqlc.narg('date_from')::timestamptz)
  AND (sqlc.narg('date_to')::timestamptz IS NULL OR vr.start_date < sqlc.narg('date_to')::timestamptz)
  AND (
        sqlc.narg('search')::text IS NULL
     OR pu.name ILIKE '%' || sqlc.narg('search')::text || '%'
     OR vr.visit_id ILIKE '%' || sqlc.narg('search')::text || '%'
     OR v.name ILIKE '%' || sqlc.narg('search')::text || '%'
     OR l.name ILIKE '%' || sqlc.narg('search')::text || '%'
     OR EXISTS (SELECT 1 FROM visitor vi WHERE vi.visit_request_id = vr.id AND vi.name ILIKE '%' || sqlc.narg('search')::text || '%')
     OR EXISTS (SELECT 1 FROM visit_purpose vp JOIN purpose p ON p.id = vp.purpose_id WHERE vp.visit_request_id = vr.id AND p.name ILIKE '%' || sqlc.narg('search')::text || '%')
  )
ORDER BY
  CASE WHEN COALESCE(sqlc.narg('sort_by')::text, 'created_at') = 'start_date' AND COALESCE(sqlc.narg('sort_order')::text, 'desc') = 'asc' THEN vr.start_date END ASC,
  CASE WHEN COALESCE(sqlc.narg('sort_by')::text, 'created_at') = 'start_date' AND COALESCE(sqlc.narg('sort_order')::text, 'desc') <> 'asc' THEN vr.start_date END DESC,
  CASE WHEN COALESCE(sqlc.narg('sort_by')::text, 'created_at') = 'end_date' AND COALESCE(sqlc.narg('sort_order')::text, 'desc') = 'asc' THEN vr.end_date END ASC,
  CASE WHEN COALESCE(sqlc.narg('sort_by')::text, 'created_at') = 'end_date' AND COALESCE(sqlc.narg('sort_order')::text, 'desc') <> 'asc' THEN vr.end_date END DESC,
  CASE WHEN COALESCE(sqlc.narg('sort_by')::text, 'created_at') = 'created_at' AND COALESCE(sqlc.narg('sort_order')::text, 'desc') = 'asc' THEN vr.created_at END ASC,
  CASE WHEN COALESCE(sqlc.narg('sort_by')::text, 'created_at') = 'created_at' AND COALESCE(sqlc.narg('sort_order')::text, 'desc') <> 'asc' THEN vr.created_at END DESC,
  vr.id DESC
LIMIT sqlc.arg('limit') OFFSET sqlc.arg('offset');

-- name: CountVisitsForSuperAdmin :one
-- Companion count; predicate is byte-for-byte the ListVisitsForSuperAdmin one.
SELECT count(*)
FROM visit_request vr
JOIN users pu ON pu.id = vr.vendor_user_id
JOIN location l ON l.id = vr.location_id
LEFT JOIN vendor v ON v.id = vr.vendor_id
WHERE (sqlc.arg('is_global')::bool OR vr.location_id = ANY(sqlc.arg('location_ids')::uuid[]))
  AND (sqlc.narg('status')::text IS NULL OR vr.status = sqlc.narg('status')::text)
  AND (sqlc.narg('date_from')::timestamptz IS NULL OR vr.start_date >= sqlc.narg('date_from')::timestamptz)
  AND (sqlc.narg('date_to')::timestamptz IS NULL OR vr.start_date < sqlc.narg('date_to')::timestamptz)
  AND (
        sqlc.narg('search')::text IS NULL
     OR pu.name ILIKE '%' || sqlc.narg('search')::text || '%'
     OR vr.visit_id ILIKE '%' || sqlc.narg('search')::text || '%'
     OR v.name ILIKE '%' || sqlc.narg('search')::text || '%'
     OR l.name ILIKE '%' || sqlc.narg('search')::text || '%'
     OR EXISTS (SELECT 1 FROM visitor vi WHERE vi.visit_request_id = vr.id AND vi.name ILIKE '%' || sqlc.narg('search')::text || '%')
     OR EXISTS (SELECT 1 FROM visit_purpose vp JOIN purpose p ON p.id = vp.purpose_id WHERE vp.visit_request_id = vr.id AND p.name ILIKE '%' || sqlc.narg('search')::text || '%')
  );

-- name: ListVisitsForLocation :many
-- Admin scope (PRD L110) and Security scope (PRD L111, L97). The scope is the
-- caller's user_locations union with is_global FALSE: a bug in the auth
-- middleware surfaces as an empty union (zero rows, fail-closed) instead of a
-- cross-branch data leak. The security gate is a date range on the same query:
-- the usecase pins date_from/date_to to today for `security` (PRD L97
-- "Hari Ini") and leaves them NULL for `admin`. The ANY on vr.location_id
-- uses idx_visit_request_location.
SELECT
    vr.*,
    l.name AS location_name, l.type AS location_type, l.timezone AS location_timezone,
    v.name AS vendor_name,
    pu.name AS vendor_user_name, pu.email AS vendor_user_email, pu.phone AS vendor_user_phone,
    COALESCE(pu.vendor_name_override, vu.name, '') AS vendor_user_vendor_name
FROM visit_request vr
JOIN location l ON l.id = vr.location_id
LEFT JOIN vendor v ON v.id = vr.vendor_id
JOIN users pu ON pu.id = vr.vendor_user_id
LEFT JOIN vendor vu ON vu.id = pu.vendor_id
WHERE (sqlc.arg('is_global')::bool OR vr.location_id = ANY(sqlc.arg('location_ids')::uuid[]))
  AND (sqlc.narg('status')::text IS NULL OR vr.status = sqlc.narg('status')::text)
  AND (sqlc.narg('date_from')::timestamptz IS NULL OR vr.start_date >= sqlc.narg('date_from')::timestamptz)
  AND (sqlc.narg('date_to')::timestamptz IS NULL OR vr.start_date < sqlc.narg('date_to')::timestamptz)
  AND (
        sqlc.narg('search')::text IS NULL
     OR pu.name ILIKE '%' || sqlc.narg('search')::text || '%'
     OR vr.visit_id ILIKE '%' || sqlc.narg('search')::text || '%'
     OR v.name ILIKE '%' || sqlc.narg('search')::text || '%'
     OR l.name ILIKE '%' || sqlc.narg('search')::text || '%'
     OR EXISTS (SELECT 1 FROM visitor vi WHERE vi.visit_request_id = vr.id AND vi.name ILIKE '%' || sqlc.narg('search')::text || '%')
     OR EXISTS (SELECT 1 FROM visit_purpose vp JOIN purpose p ON p.id = vp.purpose_id WHERE vp.visit_request_id = vr.id AND p.name ILIKE '%' || sqlc.narg('search')::text || '%')
  )
ORDER BY
  CASE WHEN COALESCE(sqlc.narg('sort_by')::text, 'created_at') = 'start_date' AND COALESCE(sqlc.narg('sort_order')::text, 'desc') = 'asc' THEN vr.start_date END ASC,
  CASE WHEN COALESCE(sqlc.narg('sort_by')::text, 'created_at') = 'start_date' AND COALESCE(sqlc.narg('sort_order')::text, 'desc') <> 'asc' THEN vr.start_date END DESC,
  CASE WHEN COALESCE(sqlc.narg('sort_by')::text, 'created_at') = 'end_date' AND COALESCE(sqlc.narg('sort_order')::text, 'desc') = 'asc' THEN vr.end_date END ASC,
  CASE WHEN COALESCE(sqlc.narg('sort_by')::text, 'created_at') = 'end_date' AND COALESCE(sqlc.narg('sort_order')::text, 'desc') <> 'asc' THEN vr.end_date END DESC,
  CASE WHEN COALESCE(sqlc.narg('sort_by')::text, 'created_at') = 'created_at' AND COALESCE(sqlc.narg('sort_order')::text, 'desc') = 'asc' THEN vr.created_at END ASC,
  CASE WHEN COALESCE(sqlc.narg('sort_by')::text, 'created_at') = 'created_at' AND COALESCE(sqlc.narg('sort_order')::text, 'desc') <> 'asc' THEN vr.created_at END DESC,
  vr.id DESC
LIMIT sqlc.arg('limit') OFFSET sqlc.arg('offset');

-- name: CountVisitsForLocation :one
SELECT count(*)
FROM visit_request vr
JOIN users pu ON pu.id = vr.vendor_user_id
JOIN location l ON l.id = vr.location_id
LEFT JOIN vendor v ON v.id = vr.vendor_id
WHERE (sqlc.arg('is_global')::bool OR vr.location_id = ANY(sqlc.arg('location_ids')::uuid[]))
  AND (sqlc.narg('status')::text IS NULL OR vr.status = sqlc.narg('status')::text)
  AND (sqlc.narg('date_from')::timestamptz IS NULL OR vr.start_date >= sqlc.narg('date_from')::timestamptz)
  AND (sqlc.narg('date_to')::timestamptz IS NULL OR vr.start_date < sqlc.narg('date_to')::timestamptz)
  AND (
        sqlc.narg('search')::text IS NULL
     OR pu.name ILIKE '%' || sqlc.narg('search')::text || '%'
     OR vr.visit_id ILIKE '%' || sqlc.narg('search')::text || '%'
     OR v.name ILIKE '%' || sqlc.narg('search')::text || '%'
     OR l.name ILIKE '%' || sqlc.narg('search')::text || '%'
     OR EXISTS (SELECT 1 FROM visitor vi WHERE vi.visit_request_id = vr.id AND vi.name ILIKE '%' || sqlc.narg('search')::text || '%')
     OR EXISTS (SELECT 1 FROM visit_purpose vp JOIN purpose p ON p.id = vp.purpose_id WHERE vp.visit_request_id = vr.id AND p.name ILIKE '%' || sqlc.narg('search')::text || '%')
  );

-- name: ListVisitsForVendorUser :many
-- Vendor-user / external-staff scope (PRD L112, AGENTS.md rule 6.1): strictly
-- WHERE vendor_user_id = auth_user.id. A vendor can never widen this to see another
-- vendor's visits, whatever they send in the query string. Uses idx_visit_vendor_user
-- (PRD L209).
SELECT
    vr.*,
    l.name AS location_name, l.type AS location_type, l.timezone AS location_timezone,
    v.name AS vendor_name,
    pu.name AS vendor_user_name, pu.email AS vendor_user_email, pu.phone AS vendor_user_phone,
    COALESCE(pu.vendor_name_override, vu.name, '') AS vendor_user_vendor_name
FROM visit_request vr
JOIN location l ON l.id = vr.location_id
LEFT JOIN vendor v ON v.id = vr.vendor_id
JOIN users pu ON pu.id = vr.vendor_user_id
LEFT JOIN vendor vu ON vu.id = pu.vendor_id
WHERE vr.vendor_user_id = sqlc.arg('vendor_user_id')::uuid
  AND (sqlc.narg('status')::text IS NULL OR vr.status = sqlc.narg('status')::text)
  AND (sqlc.narg('date_from')::timestamptz IS NULL OR vr.start_date >= sqlc.narg('date_from')::timestamptz)
  AND (sqlc.narg('date_to')::timestamptz IS NULL OR vr.start_date < sqlc.narg('date_to')::timestamptz)
  AND (
        sqlc.narg('search')::text IS NULL
     OR pu.name ILIKE '%' || sqlc.narg('search')::text || '%'
     OR vr.visit_id ILIKE '%' || sqlc.narg('search')::text || '%'
     OR v.name ILIKE '%' || sqlc.narg('search')::text || '%'
     OR l.name ILIKE '%' || sqlc.narg('search')::text || '%'
     OR EXISTS (SELECT 1 FROM visitor vi WHERE vi.visit_request_id = vr.id AND vi.name ILIKE '%' || sqlc.narg('search')::text || '%')
     OR EXISTS (SELECT 1 FROM visit_purpose vp JOIN purpose p ON p.id = vp.purpose_id WHERE vp.visit_request_id = vr.id AND p.name ILIKE '%' || sqlc.narg('search')::text || '%')
  )
ORDER BY
  CASE WHEN COALESCE(sqlc.narg('sort_by')::text, 'created_at') = 'start_date' AND COALESCE(sqlc.narg('sort_order')::text, 'desc') = 'asc' THEN vr.start_date END ASC,
  CASE WHEN COALESCE(sqlc.narg('sort_by')::text, 'created_at') = 'start_date' AND COALESCE(sqlc.narg('sort_order')::text, 'desc') <> 'asc' THEN vr.start_date END DESC,
  CASE WHEN COALESCE(sqlc.narg('sort_by')::text, 'created_at') = 'end_date' AND COALESCE(sqlc.narg('sort_order')::text, 'desc') = 'asc' THEN vr.end_date END ASC,
  CASE WHEN COALESCE(sqlc.narg('sort_by')::text, 'created_at') = 'end_date' AND COALESCE(sqlc.narg('sort_order')::text, 'desc') <> 'asc' THEN vr.end_date END DESC,
  CASE WHEN COALESCE(sqlc.narg('sort_by')::text, 'created_at') = 'created_at' AND COALESCE(sqlc.narg('sort_order')::text, 'desc') = 'asc' THEN vr.created_at END ASC,
  CASE WHEN COALESCE(sqlc.narg('sort_by')::text, 'created_at') = 'created_at' AND COALESCE(sqlc.narg('sort_order')::text, 'desc') <> 'asc' THEN vr.created_at END DESC,
  vr.id DESC
LIMIT sqlc.arg('limit') OFFSET sqlc.arg('offset');

-- name: CountVisitsForVendorUser :one
SELECT count(*)
FROM visit_request vr
JOIN users pu ON pu.id = vr.vendor_user_id
JOIN location l ON l.id = vr.location_id
LEFT JOIN vendor v ON v.id = vr.vendor_id
WHERE vr.vendor_user_id = sqlc.arg('vendor_user_id')::uuid
  AND (sqlc.narg('status')::text IS NULL OR vr.status = sqlc.narg('status')::text)
  AND (sqlc.narg('date_from')::timestamptz IS NULL OR vr.start_date >= sqlc.narg('date_from')::timestamptz)
  AND (sqlc.narg('date_to')::timestamptz IS NULL OR vr.start_date < sqlc.narg('date_to')::timestamptz)
  AND (
        sqlc.narg('search')::text IS NULL
     OR pu.name ILIKE '%' || sqlc.narg('search')::text || '%'
     OR vr.visit_id ILIKE '%' || sqlc.narg('search')::text || '%'
     OR v.name ILIKE '%' || sqlc.narg('search')::text || '%'
     OR l.name ILIKE '%' || sqlc.narg('search')::text || '%'
     OR EXISTS (SELECT 1 FROM visitor vi WHERE vi.visit_request_id = vr.id AND vi.name ILIKE '%' || sqlc.narg('search')::text || '%')
     OR EXISTS (SELECT 1 FROM visit_purpose vp JOIN purpose p ON p.id = vp.purpose_id WHERE vp.visit_request_id = vr.id AND p.name ILIKE '%' || sqlc.narg('search')::text || '%')
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
-- Status timeline on SCR-04 (openapi VisitDetail.history, PRD L232), served
-- oldest -> newest: the 50 NEWEST rows are taken first (DESC + LIMIT) so an
-- ancient visit cannot grow an unbounded payload, then reversed to ASC for
-- chronological rendering; the window always contains the newest row, so the
-- current status note is derivable from the last returned event.
-- changed_by_name/changed_by_role come from the LEFT JOINs: changed_by IS
-- NULL (the background auto-rule worker) yields NULL actor columns; the raw
-- role NAME is mapped to its Indonesian display label by domain.RoleLabel in
-- the repository, never in SQL.
SELECT s.id, s.visit_request_id, s.status, s.changed_by, s.changed_at, s.notes,
       s.changed_by_name, s.changed_by_role
FROM (
    SELECT sh.id, sh.visit_request_id, sh.status, sh.changed_by, sh.changed_at, sh.notes,
           u.name AS changed_by_name,
           r.name AS changed_by_role
    FROM status_history sh
    LEFT JOIN users u ON u.id = sh.changed_by
    LEFT JOIN role r ON r.id = u.role_id
    WHERE sh.visit_request_id = $1
    ORDER BY sh.changed_at DESC, sh.id DESC
    LIMIT 50
) s
ORDER BY s.changed_at ASC, s.id ASC;

-- name: InsertVisitor :one
-- POST /visits visitors[] (openapi L816-822), up to 10 rows per visit (QA
-- VISIT-05). vendor_id is the technician's own company (openapi VisitorItem);
-- NULL for internal staff. vendor_name_override is the manually typed company
-- (migration 000005), stored ONLY when vendor_id is absent: a sent vendor_id
-- wins and the Go caller passes NULL for the override. jabatan is the optional
-- free-text position (migration 000012); the Go caller has already trimmed it
-- and passes NULL for a blank input, so it never enters a catalogue. email is
-- the optional member contact address (migration 000022): NULL (or blank,
-- normalised to NULL by the caller) means "no mail". Cascades
-- to nothing on insert; the visit FK is ON DELETE CASCADE so deleting a visit
-- removes its roster.
INSERT INTO visitor (visit_request_id, name, id_number, phone, id_card_photo_url, photo_url, vendor_id, vendor_name_override, jabatan, email)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
RETURNING *;

-- name: ListVisitors :many
-- Roster for SCR-04 / SCR-05. Batched per page with a single IN (...) by the
-- repository to avoid an N+1 over the visit list. The vendor name rides along
-- for the openapi VisitorItem vendor_name member. phone_edited rides along
-- for the VisitorItem edited marker (migration 000021): TRUE means the owning
-- vendor once corrected the phone via PATCH /visits/{id}/visitors/{visitorId}.
SELECT v.id, v.visit_request_id, v.name, v.id_number, v.phone, v.id_card_photo_url, v.photo_url, v.created_at, v.vendor_id, v.vendor_name_override, v.jabatan, v.phone_edited, v.email,
    vn.name AS vendor_name
FROM visitor v
LEFT JOIN vendor vn ON vn.id = v.vendor_id
WHERE v.visit_request_id = ANY(sqlc.arg('visit_request_ids')::uuid[])
ORDER BY v.created_at ASC, v.id ASC;

-- name: ListVisitorJabatan :many
-- Suggestion source for the roster "Jabatan" combobox (openapi GET /jabatan).
-- Jabatan is free text, never a catalogue: the distinct values actually typed
-- so far, blanks dropped and ordered alphabetically, are offered back to the
-- form while staying freely editable. The LIMIT keeps an unbounded DISTINCT
-- scan from drifting into a huge payload; the list is short by nature because
-- real-world positions repeat.
SELECT DISTINCT jabatan
FROM visitor
WHERE jabatan IS NOT NULL AND btrim(jabatan) <> ''
ORDER BY jabatan ASC
LIMIT 50;

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

-- name: GetVisitorByIDForUpdate :one
-- Row lock for the contact-correction write path (migration 000021,
-- PATCH /visits/{id}/visitors/{visitorId}). `FOR UPDATE OF v` is required
-- because the projection LEFT JOINs vendor, and PostgreSQL refuses `FOR
-- UPDATE` on the nullable side of an outer join. The caller verifies
-- visit_request_id against the path visit id so a member of another visit
-- answers 404 instead of being corrected.
SELECT v.id, v.visit_request_id, v.name, v.id_number, v.phone, v.id_card_photo_url, v.photo_url, v.created_at, v.vendor_id, v.vendor_name_override, v.jabatan, v.phone_edited, v.email,
    vn.name AS vendor_name
FROM visitor v
LEFT JOIN vendor vn ON vn.id = v.vendor_id
WHERE v.id = $1
FOR UPDATE OF v;

-- name: UpdateVisitorContact :one
-- The single write path for the creator contact correction (migration 000021,
-- PATCH /visits/{id}/visitors/{visitorId}). The caller must hold the
-- GetVisitorByIDForUpdate row lock and pass the fully resolved phone AND the
-- resolved flag (read-modify-write, never a partial patch); the adapter
-- writes them verbatim. The flag is monotonic by contract: the caller only
-- ever passes TRUE forward, so the adapter stores max(stored, passed) via OR.
UPDATE visitor
SET phone            = $2,
    phone_edited     = phone_edited OR $3
WHERE id = $1
RETURNING id, visit_request_id, name, id_number, phone, id_card_photo_url, photo_url, created_at, vendor_id, vendor_name_override, jabatan, phone_edited, email;

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

-- name: GetWorkPhoto :one
-- Single work-proof read for the 201-vs-200 answer of
-- POST /visits/{id}/work-photos. The uploader display name rides along from
-- the users join (NULL uploaded_by, e.g. a removed account, renders "").
-- A missing (visit, kind) pair surfaces pgx.ErrNoRows (-> first attach).
SELECT wp.id, wp.visit_request_id, wp.kind, wp.url, wp.uploaded_by, wp.created_at,
    COALESCE(u.name, '') AS uploaded_by_name
FROM visit_work_photo wp
LEFT JOIN users u ON u.id = wp.uploaded_by
WHERE wp.visit_request_id = $1 AND wp.kind = $2;

-- name: ListWorkPhotosByVisit :many
-- Both work proofs for the GET /visits/{id} work_photos member and the
-- scoped file endpoint (work_before/work_after slots). At most two rows ride
-- the UNIQUE (visit_request_id, kind) anchor; kind order keeps the pair
-- deterministic (after < before alphabetically, callers key by kind anyway).
SELECT wp.id, wp.visit_request_id, wp.kind, wp.url, wp.uploaded_by, wp.created_at,
    COALESCE(u.name, '') AS uploaded_by_name
FROM visit_work_photo wp
LEFT JOIN users u ON u.id = wp.uploaded_by
WHERE wp.visit_request_id = $1
ORDER BY wp.kind ASC;

-- name: UpsertWorkPhoto :one
-- The single write path for POST /visits/{id}/work-photos. Callers must hold
-- the GetVisitByIDForUpdate row lock and must have verified the visit is
-- still `visiting` in the same transaction (the concurrent check-out gate).
-- UNIQUE (visit_request_id, kind) is the idempotency anchor: a re-attach
-- replaces the row (fresh url, uploaded_by and created_at) instead of
-- accumulating duplicates. A bad kind is rejected by the
-- chk_visit_work_photo_kind CHECK (-> 422 via MapError) as well as by the
-- usecase vocabulary check; the Go caller passes uploaded_by NULL only for
-- the empty actor (never in production: the usecase always passes the
-- authenticated caller).
INSERT INTO visit_work_photo (visit_request_id, kind, url, uploaded_by)
VALUES ($1, $2, $3, $4)
ON CONFLICT (visit_request_id, kind) DO UPDATE
SET url         = EXCLUDED.url,
    uploaded_by = EXCLUDED.uploaded_by,
    created_at  = now()
RETURNING id, visit_request_id, kind, url, uploaded_by, created_at;
