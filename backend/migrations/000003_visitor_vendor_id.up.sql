-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000003 : Add visitor.vendor_id (per-technician company)
--
-- SSOT            : docs/1. Entity Relationship Diagram (ERD).mermaid (VISITOR)
-- Business rules  : docs/0. PRD - THC Visitor App.md
-- Target engine   : PostgreSQL 18.6
--
-- Each technician travelling under a visit may belong to a different partner
-- company, so the company link lives on VISITOR, not on VISIT_REQUEST.
-- The column is NULLable: internal THC staff file visits with no vendor.
-- visit_request.vendor_id (migration 000001) is left untouched for legacy rows;
-- the create path no longer writes it.
-- =============================================================================

ALTER TABLE visitor ADD COLUMN vendor_id uuid REFERENCES vendor (id);

COMMENT ON COLUMN visitor.vendor_id IS 'Perusahaan vendor teknisi (opsional); NULL untuk staf internal THC';
