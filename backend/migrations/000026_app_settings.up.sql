-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000026 : App settings (notification matrix)
--
-- SSOT            : docs/0. PRD - THC Visitor App.md
-- Business rules  : docs/0. PRD - THC Visitor App.md
-- Target engine   : PostgreSQL 18.6
--
-- app_settings is a generic key/value store for runtime-tunable configuration
-- that does not warrant its own table. The first (and currently only) key is
-- "notifications", holding the per-event/per-channel/per-audience toggle matrix
-- consumed by the notification emit path and the reminder worker.
--
-- SCOPE NOTE
--   Purely additive: one new table plus one seed row. No existing column,
--   constraint or index is altered.
-- =============================================================================

CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT        PRIMARY KEY,
    value      JSONB       NOT NULL,
    version    INT         NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by UUID        REFERENCES users (id) ON DELETE SET NULL
);

INSERT INTO app_settings (key, value, version)
VALUES (
    'notifications',
    '{"visit_requested":{"in_app":{"staff":true,"vendor":true},"email":{"staff":true,"vendor":true}},"visit_rescheduled":{"in_app":{"staff":true,"vendor":true},"email":{"staff":true,"vendor":true}},"visit_check_in":{"in_app":{"staff":true,"vendor":true},"email":{"staff":true,"vendor":true}},"visit_check_out":{"in_app":{"staff":true,"vendor":true},"email":{"staff":true,"vendor":true}},"visit_cancelled":{"in_app":{"staff":true,"vendor":true},"email":{"staff":true,"vendor":true}},"visit_approved":{"in_app":{"staff":true,"vendor":true},"email":{"staff":true,"vendor":true}},"visit_rejected":{"in_app":{"staff":true,"vendor":true},"email":{"staff":true,"vendor":true}},"visit_reminder":{"in_app":{"staff":true,"vendor":true},"email":{"staff":true,"vendor":true}},"visit_auto_cancelled":{"in_app":{"staff":true,"vendor":true},"email":{"staff":true,"vendor":true}}}'::jsonb,
    1
)
ON CONFLICT (key) DO NOTHING;
