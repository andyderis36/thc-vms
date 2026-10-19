-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000007 DOWN : Teardown of the audit log.
--
-- Dropping the table removes the trail and its two indexes implicitly
-- (indexes cannot outlive their table). status_history and users are
-- untouched: this down migration must never widen its blast radius beyond
-- the audit_log table created in the up migration.
-- =============================================================================

DROP TABLE IF EXISTS audit_log;
