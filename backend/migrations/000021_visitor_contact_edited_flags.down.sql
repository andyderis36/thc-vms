-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000021 : Teardown of visitor.phone_edited.
--
-- A bare `000021 up; 000021 down` restores the 000001..000020 schema exactly.
-- =============================================================================

ALTER TABLE visitor DROP COLUMN IF EXISTS phone_edited;
