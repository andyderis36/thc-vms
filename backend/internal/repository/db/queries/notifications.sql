-- =============================================================================
-- notifications.sql - Persisted per-user notification store (migration 000008).
--
-- The READ-ONLY derived feed (UNION over status_history/check_in/check_out) has
-- been replaced by materialised rows: one row per (recipient, event type, visit).
--
-- WRITE PATH
--   Rows are written INSIDE the existing visit status-write transactions (see
--   internal/repository/notification_emit.go), so a notice can never exist
--   without its triggering transition. Recipients are resolved by SQL fan-out:
--     staff  = every ACTIVE national super_admin plus the ACTIVE admin/security
--              stationed at the visit's branch (users.location_id).
--     vendor = the visit's vendor_user_id, but ONLY when that account holds the
--              'vendor' role (company-wide fan-out is deliberately rejected).
--
-- IDEMPOTENCY
--   Every insert carries ON CONFLICT (user_id, type, visit_request_id) DO
--   NOTHING. That unique constraint is the SINGLE de-duplication mechanism: it
--   makes the reminder sweep safe across ticks, restarts and concurrent
--   workers, and lets the one-off backfill command be re-run without
--   double-posting.
--
-- READ PATH
--   Reads are user-scoped (WHERE user_id = caller). The optional location_id
--   narrows a super_admin's national feed by branch; it never widens a scoped
--   caller because the user_id predicate is always present.
-- =============================================================================

-- name: InsertStaffNotifications :exec
-- Fan-out to the visit's staff audience: every active super_admin (national,
-- including the hidden dev-superadmin which passes every super_admin gate)
-- plus the active admin/security at the visit's location. ON CONFLICT keeps the
-- write idempotent per (recipient, type, visit).
INSERT INTO notification (user_id, visit_request_id, type, title, message, created_at)
SELECT u.id,
       sqlc.arg('visit_request_id')::uuid,
       sqlc.arg('type')::text,
       sqlc.arg('title')::text,
       sqlc.arg('message')::text,
       sqlc.arg('created_at')::timestamptz
FROM users u
JOIN role r ON r.id = u.role_id
WHERE u.status = 'active'
  AND (
        r.name IN ('super_admin', 'dev-superadmin')
        OR (r.name IN ('admin', 'security') AND u.location_id = sqlc.arg('location_id')::uuid)
      )
ON CONFLICT (user_id, type, visit_request_id) DO NOTHING;

-- name: InsertVendorNotification :exec
-- Single-recipient insert: the visit's vendor user, but only if that account is a
-- 'vendor'. A vendor account that is internal staff (admin-posted request) receives
-- nothing here; the staff fan-out above already covers them.
INSERT INTO notification (user_id, visit_request_id, type, title, message, created_at)
SELECT u.id,
       sqlc.arg('visit_request_id')::uuid,
       sqlc.arg('type')::text,
       sqlc.arg('title')::text,
       sqlc.arg('message')::text,
       sqlc.arg('created_at')::timestamptz
FROM users u
JOIN role r ON r.id = u.role_id
WHERE u.id = sqlc.arg('vendor_user_id')::uuid
  AND r.name = 'vendor'
ON CONFLICT (user_id, type, visit_request_id) DO NOTHING;

-- name: ListNotificationsForUser :many
-- One page of the caller's own notifications, newest first, joined to the visit
-- and its location for the visit_id/location_name the wire shape needs.
SELECT n.id,
       n.type,
       n.visit_request_id,
       vr.visit_id,
       vr.location_id,
       l.name AS location_name,
       n.title,
       n.message,
       n.is_read,
       n.created_at AS occurred_at
FROM notification n
JOIN visit_request vr ON vr.id = n.visit_request_id
JOIN location l ON l.id = vr.location_id
WHERE n.user_id = sqlc.arg('user_id')::uuid
  AND (sqlc.narg('location_id')::uuid IS NULL OR vr.location_id = sqlc.narg('location_id')::uuid)
ORDER BY n.created_at DESC, n.id DESC
LIMIT sqlc.arg('limit') OFFSET sqlc.arg('offset');

-- name: CountNotificationsForUser :one
-- Companion count; predicate is byte-for-byte the ListNotificationsForUser one
-- so {items,total} cannot drift from the page it counts.
SELECT count(*)::bigint AS count
FROM notification n
JOIN visit_request vr ON vr.id = n.visit_request_id
WHERE n.user_id = sqlc.arg('user_id')::uuid
  AND (sqlc.narg('location_id')::uuid IS NULL OR vr.location_id = sqlc.narg('location_id')::uuid);

-- name: CountUnreadNotificationsForUser :one
-- Global unread count for the badge: unaffected by the location_id filter
-- (openapi NotificationListResponse.data.unread_count).
SELECT count(*)::bigint AS count
FROM notification
WHERE user_id = sqlc.arg('user_id')::uuid
  AND is_read = false;

-- name: MarkNotificationRead :execrows
-- Mark ONE owned notification read. The user_id predicate is the ownership
-- guard: a notification owned by somebody else matches no row and the caller
-- answers 404.
UPDATE notification
SET is_read = true
WHERE id = sqlc.arg('id')::uuid
  AND user_id = sqlc.arg('user_id')::uuid;

-- name: MarkAllNotificationsRead :execrows
-- Mark every unread notification of the caller read; returns the count.
UPDATE notification
SET is_read = true
WHERE user_id = sqlc.arg('user_id')::uuid
  AND is_read = false;

-- name: ListBackfillNotificationEvents :many
-- One-off backfill source (cmd/backfill-notifications): the UNION of every
-- event that should have produced a notification before the store existed.
--   requested : every visit_request at its created_at (Create writes no history row)
--   status    : every status_history row, mapped through the same status->template
--               rule (is_system = changed_by IS NULL distinguishes auto from manual)
--   check_in  : every gate check-in at its timestamp
--   check_out : every gate check-out at its timestamp
-- The command maps each row through the domain templates and inserts through
-- InsertStaffNotifications / InsertVendorNotification, so duplicate event types
-- collapse on the unique constraint. No time parameter: the full history is
-- replayed once, and re-running is a no-op thanks to ON CONFLICT DO NOTHING.
SELECT 'requested'::text AS source,
       ''::text AS status,
       false::boolean AS is_system,
       vr.id AS visit_request_id,
       vr.visit_id AS visit_id,
       vr.location_id AS location_id,
       vr.vendor_user_id AS vendor_user_id,
       vr.created_at AS occurred_at
FROM visit_request vr

UNION ALL

SELECT 'status'::text,
       sh.status,
       (sh.changed_by IS NULL),
       vr.id,
       vr.visit_id,
       vr.location_id,
       vr.vendor_user_id,
       sh.changed_at
FROM status_history sh
JOIN visit_request vr ON vr.id = sh.visit_request_id

UNION ALL

SELECT 'check_in'::text,
       ''::text,
       false::boolean,
       vr.id,
       vr.visit_id,
       vr.location_id,
       vr.vendor_user_id,
       ci.checked_in_at
FROM check_in ci
JOIN visit_request vr ON vr.id = ci.visit_request_id

UNION ALL

SELECT 'check_out'::text,
       ''::text,
       false::boolean,
       vr.id,
       vr.visit_id,
       vr.location_id,
       vr.vendor_user_id,
       co.checked_out_at
FROM check_out co
JOIN visit_request vr ON vr.id = co.visit_request_id

ORDER BY occurred_at ASC;
