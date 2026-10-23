-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000012 : Teardown of visitor.jabatan.
--
-- A bare `000012 up; 000012 down` restores the 000001..000011 schema exactly.
-- =============================================================================

ALTER TABLE visitor DROP COLUMN IF EXISTS jabatan;
