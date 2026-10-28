-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000014 : Teardown of users.avatar_url.
--
-- Dropping the column leaves every other 000013 column untouched, so a bare
-- `000014 up; 000014 down` restores the 000013 schema exactly as it was.
-- =============================================================================

ALTER TABLE users DROP COLUMN IF EXISTS avatar_url;
