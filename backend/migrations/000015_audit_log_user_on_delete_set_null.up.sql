-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000015 : audit_log.user_id ON DELETE SET NULL
--
-- SSOT   : docs/1. Entity Relationship Diagram (ERD).mermaid (AUDIT_LOG)
-- ENGINE : PostgreSQL 18.6
--
-- DECISION CHANGE (supersedes the "plain FK" note in 000007)
--   000007 kept the FK actionless so deleting an account could never wipe the
--   trail. That also made account deletion impossible: a user owning any audit
--   row hit 23503 and the API answered 409. The trail must outlive its actor,
--   so the reference is now detached instead of blocking. ON DELETE SET NULL
--   keeps the row (action, entity, entity_id, timestamp, ip, user_agent,
--   metadata) and only clears user_id - a column that was already nullable for
--   system-initiated rows, so no reader changes.
--
-- LOCK NOTE
--   NOT VALID + VALIDATE keeps the ACCESS EXCLUSIVE window to the two catalog
--   updates: existing rows are checked afterwards under SHARE UPDATE EXCLUSIVE,
--   so concurrent appends are not blocked while the table is scanned.
-- =============================================================================

ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_user_id_fkey;

ALTER TABLE audit_log
    ADD CONSTRAINT audit_log_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL NOT VALID;

ALTER TABLE audit_log VALIDATE CONSTRAINT audit_log_user_id_fkey;
