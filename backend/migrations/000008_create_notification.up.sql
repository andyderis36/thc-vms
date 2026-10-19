-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000008 : Notification (Phase 2 extension entity, now implemented)
--
-- SSOT            : docs/1. Entity Relationship Diagram (ERD).mermaid (NOTIFICATION)
--                   docs/4. openapi.yaml (Notification schema)
-- Business rules  : docs/0. PRD - THC Visitor App.md
-- Target engine   : PostgreSQL 18.6
--
-- SCOPE NOTE
--   000001 deliberately deferred the Phase 2 extension entities; 000007 created
--   audit_log. This migration creates NOTIFICATION - the persisted, per-user
--   notification store that replaces the read-only derived activity feed.
--   The other two Phase 2 entities (FEEDBACK, INCIDENT_REPORT) stay uncreated.
--
-- DESIGN (locked by architecture review)
--   Materialised per-user rows: one row per (recipient user, event type, visit).
--   Rows are written INSIDE the existing visit status-write transactions, so a
--   notification can never exist without its triggering transition (and vice
--   versa). Recipients are resolved by SQL fan-out: staff = every active
--   national super_admin plus the active admin/security at the visit's branch;
--   vendor = the visit's pic_user_id when that account holds the vendor role.
--
-- IDEMPOTENCY
--   uq_notification_user_type_visit makes every insert path
--   `ON CONFLICT DO NOTHING`-safe: it is the single mechanism that de-duplicates
--   the reminder sweep across ticks, restarts and concurrent workers, and that
--   lets the one-off backfill command be re-runnable without double-posting.
--
-- IF NOT EXISTS mirrors 000006/000007 so a scratch integration database that
-- re-applies the whole migration set stays safe.
-- =============================================================================

CREATE TABLE IF NOT EXISTS notification (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    visit_request_id uuid        NOT NULL REFERENCES visit_request (id) ON DELETE CASCADE,
    type             text        NOT NULL,
    title            text        NOT NULL,
    message          text        NOT NULL,
    channel          text        NOT NULL DEFAULT 'in_app',
    is_read          boolean     NOT NULL DEFAULT false,
    created_at       timestamptz NOT NULL DEFAULT now(),

    -- Closed vocabulary pinned by docs/4. openapi.yaml Notification.type.
    CONSTRAINT chk_notification_type CHECK (type IN (
        'visit_requested', 'visit_rescheduled', 'visit_check_in', 'visit_check_out',
        'visit_approved', 'visit_rejected', 'visit_reminder', 'visit_auto_cancelled')),
    -- ERD keeps the channel column; only 'in_app' is written in the MVP.
    CONSTRAINT chk_notification_channel CHECK (channel IN ('in_app', 'email', 'wa')),
    -- One notice per recipient per event type per visit (see IDEMPOTENCY above).
    CONSTRAINT uq_notification_user_type_visit UNIQUE (user_id, type, visit_request_id)
);

COMMENT ON TABLE  notification IS 'Persisted per-user notification feed - ERD NOTIFICATION entity; written in the visit lifecycle transactions, read user-scoped';
COMMENT ON COLUMN notification.channel IS 'Delivery channel; only in_app is used in the MVP (email/wa reserved by the ERD)';
COMMENT ON COLUMN notification.is_read IS 'Per-user read flag; drives the unread badge and the read/unread styling';

-- List page: newest first per user (id tiebreak keeps paging stable).
CREATE INDEX IF NOT EXISTS idx_notification_user_created
    ON notification (user_id, created_at DESC, id DESC);
-- Unread badge: partial index keeps the count cheap regardless of table size.
CREATE INDEX IF NOT EXISTS idx_notification_user_unread
    ON notification (user_id) WHERE is_read = false;
