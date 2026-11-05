-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000022 : Add visitor.email (optional contact email of a member)
--
-- SSOT            : docs/1. Entity Relationship Diagram (ERD).mermaid (VISITOR)
-- Contract        : docs/4. openapi.yaml (VisitorItem.email)
-- Business rules  : docs/0. PRD - THC Visitor App.md
-- Target engine   : PostgreSQL 18.6
--
-- Each roster member may carry an optional email address used only as the
-- recipient of approval / QR notification mail (spike: renderEmailHTML cid +
-- enqueueEmail + compose EmbedReadSeeker). Absence (NULL) and an empty value
-- both mean "no mail"; the plumbing layer normalises them identically.
--
-- The column is NULLable: legacy rows and members without an address keep no
-- value. Length is capped by server-side validation plus maxLength in the
-- openapi (no CHECK constraint), matching visitor.jabatan (000012) and
-- visitor.vendor_name_override.
-- =============================================================================

ALTER TABLE visitor ADD COLUMN email text NULL;

COMMENT ON COLUMN visitor.email IS 'Email kontak anggota pengunjung (opsional, maks 254 char); NULL atau kosong berarti tidak ada surat yang dikirim';
