-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000003 : Teardown of visitor.vendor_id.
--
-- Dropping the column removes the vendor FK implicitly, so a bare
-- `000003 up; 000003 down` leaves the 000001+000002 schema exactly as it was.
-- =============================================================================

ALTER TABLE visitor DROP COLUMN IF EXISTS vendor_id;
