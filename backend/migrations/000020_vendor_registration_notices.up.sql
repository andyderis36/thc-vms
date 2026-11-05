-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000020 : Vendor registration notices (superadmin approval queue)
--
-- SSOT            : docs/1. Entity Relationship Diagram (ERD).mermaid (USER)
--                   backend/internal/domain/vendor_registration_notice.go
--                   (VendorRegistrationNotice, VendorRegistrationNoticeRepository)
-- Business rules  : Public self-registration (POST /auth/register, migration
--                   000018) creates vendor accounts with status pending. This
--                   table is the durable per-vendor queue row behind
--                   GET /notifications/pending-registrations: one row per
--                   pending vendor user, resolved (approved/rejected) when a
--                   superadmin flips the account status (PATCH /users/:id/status).
--
-- SCOPE NOTE
--   Forward-only creation. History is immutable: migrations 000008 and 000019
--   (the notification store and its type widening) are untouched; no
--   notification-table/query change happens here.
--
-- IDEMPOTENCY
--   UNIQUE (vendor_user_id) is the idempotency anchor: every insert path must
--   be `ON CONFLICT (vendor_user_id) DO NOTHING`-safe so re-registration
--   retries, worker restarts and the backfill CLI never double-post.
--
-- IF NOT EXISTS mirrors 000006/000007/000008 so a scratch integration
-- database that re-applies the whole migration set stays safe.
-- =============================================================================

CREATE TABLE IF NOT EXISTS vendor_registration_notices (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_user_id uuid        NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
    status         text        NOT NULL DEFAULT 'pending',
    resolved_at    timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),

    -- Closed vocabulary: a notice is either waiting, accepted or refused.
    CONSTRAINT chk_vendor_registration_notices_status CHECK (status IN (
        'pending', 'approved', 'rejected'))
);

COMMENT ON TABLE  vendor_registration_notices IS 'Durable per-vendor registration queue - one row per pending vendor user behind GET /notifications/pending-registrations';
COMMENT ON COLUMN vendor_registration_notices.vendor_user_id IS 'The pending vendor account; UNIQUE is the ON CONFLICT DO NOTHING idempotency anchor';
COMMENT ON COLUMN vendor_registration_notices.status IS 'Queue state; pending rows drive the superadmin approval bell';
COMMENT ON COLUMN vendor_registration_notices.resolved_at IS 'When a superadmin approved/rejected the registration; NULL while pending';

-- Approval bell: partial index keeps the pending count cheap regardless of
-- table size (mirrors idx_notification_user_unread on the notification store).
CREATE INDEX IF NOT EXISTS idx_vendor_registration_notices_pending
    ON vendor_registration_notices (created_at DESC, id DESC) WHERE status = 'pending';
