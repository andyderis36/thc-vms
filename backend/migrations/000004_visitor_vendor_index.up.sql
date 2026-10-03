-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000004 : Index visitor.vendor_id (per-technician company)
--
-- SSOT            : docs/1. Entity Relationship Diagram (ERD).mermaid (VISITOR)
-- Business rules  : docs/0. PRD - THC Visitor App.md
-- Target engine   : PostgreSQL 18.6
--
-- The per-visitor vendor lookup (membership check against the active
-- catalogue plus roster rendering) filters on visitor.vendor_id, so the FK
-- column added in 000003 gets its own index. The FK itself stays RESTRICT:
-- vendor master rows referenced by any visitor row cannot be deleted, which
-- keeps the catalogue stable while visits point at it.
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_visitor_vendor_id ON visitor (vendor_id);
