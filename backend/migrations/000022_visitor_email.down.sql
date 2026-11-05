-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000022 : Teardown of visitor.email.
--
-- A bare `000022 up; 000022 down` restores the 000001..000021 schema exactly.
-- =============================================================================

ALTER TABLE visitor DROP COLUMN IF EXISTS email;
