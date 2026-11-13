-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000031 (DOWN) : Revert the mail_log Bcc column.
-- =============================================================================

ALTER TABLE mail_log
    DROP COLUMN IF EXISTS bcc;
