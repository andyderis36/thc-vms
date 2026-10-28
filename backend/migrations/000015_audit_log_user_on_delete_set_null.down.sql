-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000015 DOWN : restore the actionless audit_log.user_id FK.
--
-- Restoring the 000007 behaviour (NO ACTION) makes account deletion fail again
-- with 23503 for any user that owns audit rows. Rows already detached by the up
-- migration keep user_id NULL - the FK admits NULL, so no data rewrite is
-- needed and none is attempted.
-- =============================================================================

ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_user_id_fkey;

ALTER TABLE audit_log
    ADD CONSTRAINT audit_log_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users (id) NOT VALID;

ALTER TABLE audit_log VALIDATE CONSTRAINT audit_log_user_id_fkey;
