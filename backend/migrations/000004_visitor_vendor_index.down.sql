-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000004 : Teardown of the visitor.vendor_id index.
--
-- Dropping the index removes only the lookup acceleration; the vendor_id
-- column and its RESTRICT FK from 000003 stay intact.
-- =============================================================================

DROP INDEX IF EXISTS idx_visitor_vendor_id;
