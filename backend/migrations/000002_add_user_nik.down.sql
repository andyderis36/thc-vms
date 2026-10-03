-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000002 : Teardown of users.nik.
--
-- Dropping the column removes its UNIQUE index and the chk_users_nik CHECK
-- implicitly, so a bare `000002 up; 000002 down` leaves the 000001 schema
-- exactly as it was.
-- =============================================================================

ALTER TABLE users DROP COLUMN IF EXISTS nik;
