-- =============================================================================
-- suggestions.sql - Read-only suggestion feeds for the visit request form
-- (T8 vendor identity + T10 member reuse).
--
-- These statements NEVER write. Manual typing stays client-side and never
-- becomes master data: the vendor catalogue is only ever read here.
--
-- SCOPE INVARIANT (PRD L109-112, AGENTS.md rule 6.1)
--   The branch union rides the same `(is_global OR location_id = ANY(...))`
--   predicate the visit list uses, so an admin sees only vendors/members that
--   appear on a visit inside its user_locations union. An empty union with
--   is_global FALSE matches no row (fail-closed). The vendor-role member feed
--   is a SEPARATE statement pinned to `vendor_user_id = auth_user.id`, so no
--   parameter can widen it to another vendor's history.
-- =============================================================================

-- name: ListVendorSuggestionSources :many
-- Raw vendor-name sources for GET /vendors/suggestions, merged (dedupe +
-- priority master > account > history) in the usecase so the rule is unit
-- tested. Master = active vendor.catalogue name. Account = the MANUAL company
-- override typed on a vendor-role account (users.vendor_name_override).
-- History = the visit-level display name (override wins over the catalogue
-- join). For a branch caller master/account names qualify ONLY when the same
-- normalized name appears on a visit inside the caller's union, which is the
-- "vendors with at least one visit in scope" rule; a global caller gets every
-- source row. q is a trimmed prefix filter (NULL = unfiltered).
WITH scoped_visits AS (
    SELECT
        vr.vendor_user_id,
        btrim(COALESCE(NULLIF(btrim(vr.vendor_name_override), ''), mv.name, '')) AS visit_vendor_name
    FROM visit_request vr
    LEFT JOIN vendor mv ON mv.id = vr.vendor_id
    WHERE (sqlc.arg('is_global')::bool
           OR vr.location_id = ANY(sqlc.arg('location_ids')::uuid[]))
),
scoped_names AS (
    SELECT DISTINCT lower(sv.visit_vendor_name) AS name_key
    FROM scoped_visits sv
    WHERE sv.visit_vendor_name <> ''
    UNION
    SELECT DISTINCT lower(btrim(COALESCE(NULLIF(btrim(au.vendor_name_override), ''), av.name, ''))) AS name_key
    FROM scoped_visits sv
    JOIN users au ON au.id = sv.vendor_user_id
    LEFT JOIN vendor av ON av.id = au.vendor_id
    WHERE btrim(COALESCE(NULLIF(btrim(au.vendor_name_override), ''), av.name, '')) <> ''
)
SELECT src.name, src.source
FROM (
    SELECT DISTINCT btrim(v.name) AS name, 'master'::text AS source
    FROM vendor v
    WHERE v.is_blacklisted = false
      AND btrim(v.name) <> ''
      AND (sqlc.arg('is_global')::bool
           OR lower(btrim(v.name)) IN (SELECT name_key FROM scoped_names))
    UNION ALL
    SELECT DISTINCT btrim(u.vendor_name_override) AS name, 'account'::text AS source
    FROM users u
    JOIN role r ON r.id = u.role_id
    WHERE r.name = 'vendor'
      AND u.vendor_name_override IS NOT NULL
      AND btrim(u.vendor_name_override) <> ''
      AND (sqlc.arg('is_global')::bool
           OR lower(btrim(u.vendor_name_override)) IN (SELECT name_key FROM scoped_names))
    UNION ALL
    SELECT DISTINCT sv.visit_vendor_name AS name, 'history'::text AS source
    FROM scoped_visits sv
    WHERE sv.visit_vendor_name <> ''
) src
WHERE (sqlc.narg('q')::text IS NULL OR src.name ILIKE sqlc.narg('q')::text || '%')
ORDER BY src.name ASC;

-- name: ListMemberSuggestionsForScope :many
-- Member reuse feed for admin/super_admin on GET /visits/member-suggestions.
-- One row per (case-insensitive name, phone) pair, keeping the NEWEST visit
-- (start_date, then id) so the reused contact data is the freshest. The list
-- is photo-less on purpose: id_card_photo_url/photo_url are PII-heavy and are
-- served only by the single-member pick endpoint. The row's visitor id is
-- included so the client can call GET /visits/member-suggestions/{visitorId}
-- directly for the detail (with photos) of the winning dedupe row. vendor_name
-- narrows to the visits whose resolved vendor display name (visit
-- override/catalogue) OR owning vendor-account company equals the trimmed
-- value. q matches the member name anywhere (ILIKE) and is capped/validated by
-- the usecase.
SELECT DISTINCT ON (lower(btrim(vi.name)), vi.phone)
    vi.id AS visitor_id,
    vi.name,
    vi.id_number,
    vi.phone,
    vi.email,
    vi.jabatan,
    vr.start_date AS last_visit_at,
    vr.id AS source_visit_id
FROM visitor vi
JOIN visit_request vr ON vr.id = vi.visit_request_id
LEFT JOIN vendor v ON v.id = vr.vendor_id
JOIN users pu ON pu.id = vr.vendor_user_id
LEFT JOIN vendor puv ON puv.id = pu.vendor_id
WHERE (sqlc.arg('is_global')::bool
       OR vr.location_id = ANY(sqlc.arg('location_ids')::uuid[]))
  AND (sqlc.narg('vendor_name')::text IS NULL
       OR lower(btrim(COALESCE(NULLIF(btrim(vr.vendor_name_override), ''), v.name, ''))) = lower(btrim(sqlc.narg('vendor_name')::text))
       OR lower(btrim(COALESCE(NULLIF(btrim(pu.vendor_name_override), ''), puv.name, ''))) = lower(btrim(sqlc.narg('vendor_name')::text)))
  AND (sqlc.narg('q')::text IS NULL OR vi.name ILIKE '%' || sqlc.narg('q')::text || '%')
ORDER BY lower(btrim(vi.name)), vi.phone, vr.start_date DESC, vr.id DESC
LIMIT 20;

-- name: ListMemberSuggestionsForVendor :many
-- Vendor-role member reuse feed: STRICTLY the actor's own visits
-- (visit_request.vendor_user_id = auth_user.id). The row's visitor id is
-- included so the client can call GET /visits/member-suggestions/{visitorId}
-- directly for the detail (with photos) of the winning dedupe row. There is
-- deliberately no branch/location or vendor-name parameter here: ownership is
-- the only scope, and the usecase ignores any client-supplied vendor filter for
-- this role.
SELECT DISTINCT ON (lower(btrim(vi.name)), vi.phone)
    vi.id AS visitor_id,
    vi.name,
    vi.id_number,
    vi.phone,
    vi.email,
    vi.jabatan,
    vr.start_date AS last_visit_at,
    vr.id AS source_visit_id
FROM visitor vi
JOIN visit_request vr ON vr.id = vi.visit_request_id
WHERE vr.vendor_user_id = sqlc.arg('vendor_user_id')::uuid
  AND (sqlc.narg('q')::text IS NULL OR vi.name ILIKE '%' || sqlc.narg('q')::text || '%')
ORDER BY lower(btrim(vi.name)), vi.phone, vr.start_date DESC, vr.id DESC
LIMIT 20;

-- name: GetVisitorByID :one
-- One roster member by primary key for GET /visits/member-suggestions/{id}.
-- The usecase resolves the owning visit and applies the SAME read scope the
-- visit detail uses BEFORE this row is returned; an out-of-scope or unknown
-- id must stay indistinguishable (404). This is a plain read (no FOR UPDATE).
SELECT
    vi.id, vi.visit_request_id, vi.name, vi.id_number, vi.phone,
    vi.id_card_photo_url, vi.photo_url, vi.created_at, vi.vendor_id,
    vi.vendor_name_override, vi.jabatan, vi.phone_edited, vi.email,
    vn.name AS vendor_name
FROM visitor vi
LEFT JOIN vendor vn ON vn.id = vi.vendor_id
WHERE vi.id = $1;
