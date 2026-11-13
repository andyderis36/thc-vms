-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000031 : Bcc column on mail_log (overseer trail for Bcc sends).
--
-- SSOT            : docs/0. PRD - THC Visitor App.md
-- Business rules  : docs/0. PRD - THC Visitor App.md
-- Target engine   : PostgreSQL 18.6
--
-- Lifecycle fan-outs put the direct owners in To and the national overseers
-- (super_admin incl. the hidden dev-superadmin) in Bcc, so overseers stay
-- informed without being visible to the direct recipients. The Bcc set must
-- still be observable to the back-office, hence this column: it is PURE
-- OBSERVABILITY, mirroring the recipients column (never read by any send
-- path, only by GET /settings/mail-logs).
--
-- SCOPE NOTE
--   Purely additive: one new NOT NULL column with a default. No existing
--   column, constraint or index is altered; pre-existing rows read back as
--   an empty Bcc set.
-- =============================================================================

ALTER TABLE mail_log
    ADD COLUMN IF NOT EXISTS bcc text[] NOT NULL DEFAULT '{}';
