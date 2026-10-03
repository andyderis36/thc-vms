-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000005 : Teardown of manual company names + free-typed purpose.
--
-- Dropping the three columns removes the manual-text feature implicitly; a
-- bare `000005 up; 000005 down` leaves the 000001..000004 schema exactly as
-- it was. Catalogue data (vendor, purpose) is untouched: manual values were
-- never part of any catalogue.
-- =============================================================================

ALTER TABLE visitor DROP COLUMN IF EXISTS vendor_name_override;

ALTER TABLE visit_request DROP COLUMN IF EXISTS purpose_note;

ALTER TABLE users DROP COLUMN IF EXISTS vendor_name_override;
