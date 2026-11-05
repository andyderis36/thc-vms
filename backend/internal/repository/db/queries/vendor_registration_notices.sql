-- =============================================================================
-- vendor_registration_notices.sql - Superadmin approval queue (migration 000020).
--
-- The durable per-vendor row behind GET /notifications/pending-registrations
-- and the superadmin approval bell: public self-registration (migration
-- 000018) creates one pending vendor account, which gains exactly one row
-- here, resolved when a superadmin flips the account status
-- (PATCH /users/:id/status).
--
-- SCOPE NOTE
--   This file owns ONLY the notices queue. The dev-superadmin parity
--   predicate (ListStaffEmailRecipients) and any recipient fan-out live in
--   notifications.sql and are deliberately untouched here.
--
-- IDEMPOTENCY
--   UNIQUE (vendor_user_id) is the anchor: every insert carries
--   ON CONFLICT (vendor_user_id) DO NOTHING, so re-registration retries,
--   worker restarts and the backfill CLI never double-post and never touch
--   the first row.
--
-- READ PATH
--   ListPendingVendorRegistrations serves the newest pending rows first
--   (ORDER BY created_at DESC, id DESC rides the partial index
--   idx_vendor_registration_notices_pending). CountPendingVendorRegistrationNotices
--   shares the same WHERE status = 'pending' predicate plus the users join
--   shape, so {items,total,pending_count} cannot drift from the page it
--   counts: the FK (vendor_user_id -> users, ON DELETE CASCADE) guarantees
--   every pending notice has exactly one user row.
-- =============================================================================

-- name: InsertPendingVendorRegistrationNotice :exec
-- Queue one pending vendor account. ON CONFLICT DO NOTHING keeps the retry
-- idempotent per UNIQUE(vendor_user_id): a second call for the same vendor
-- affects zero rows and leaves the first row (its id, status, created_at)
-- untouched.
INSERT INTO vendor_registration_notices (vendor_user_id)
VALUES (sqlc.arg('vendor_user_id')::uuid)
ON CONFLICT (vendor_user_id) DO NOTHING;

-- name: ResolveVendorRegistrationNotice :execrows
-- Flip one pending notice to approved/rejected and stamp resolved_at. The
-- status = 'pending' guard makes a repeated decision a no-op instead of
-- re-stamping: an already resolved (or missing) row affects zero rows.
UPDATE vendor_registration_notices
SET status      = sqlc.arg('status')::text,
    resolved_at = now()
WHERE vendor_user_id = sqlc.arg('vendor_user_id')::uuid
  AND status = 'pending';

-- name: ListPendingVendorRegistrations :many
-- One page of the superadmin approval queue, newest first, joined onto the
-- vendor account (plus its catalogue vendor name) so the approval screen
-- renders the openapi PendingRegistrationItem without a second hop.
SELECT n.vendor_user_id,
       u.name,
       u.email,
       u.phone,
       u.nik,
       u.vendor_name_override,
       v.name AS vendor_name,
       n.created_at,
       n.status
FROM vendor_registration_notices n
JOIN users u ON u.id = n.vendor_user_id
LEFT JOIN vendor v ON v.id = u.vendor_id
WHERE n.status = 'pending'
ORDER BY n.created_at DESC, n.id DESC
LIMIT sqlc.arg('limit') OFFSET sqlc.arg('offset');

-- name: CountPendingVendorRegistrationNotices :one
-- Companion bell count; predicate is the ListPendingVendorRegistrations one
-- (pending notices, each with exactly one user row via the FK), so the count
-- cannot drift from the page it accompanies.
SELECT count(*)::bigint AS count
FROM vendor_registration_notices n
JOIN users u ON u.id = n.vendor_user_id
WHERE n.status = 'pending';
