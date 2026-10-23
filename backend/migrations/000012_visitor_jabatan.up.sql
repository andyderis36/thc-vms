-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000012 : Add visitor.jabatan (free-text position of a roster member)
--
-- SSOT            : docs/1. Entity Relationship Diagram (ERD).mermaid (VISITOR)
-- Contract        : docs/4. openapi.yaml (VisitorItem.jabatan, GET /jabatan)
-- Business rules  : docs/0. PRD - THC Visitor App.md
-- Target engine   : PostgreSQL 18.6
--
-- The roster used to be "Daftar Tim Teknisi"; it now admits any visiting member
-- (supervisor, manager, neighbour, ...), so each row carries an optional
-- free-text Jabatan. This is NEVER a catalogue entry: there is no jabatan table,
-- no foreign key and no dropdown master data. Values typed earlier are offered
-- back only as suggestions (GET /jabatan derives the distinct list from this
-- column) while the field stays freely editable.
--
-- The column is NULLable: legacy rows and members without a title keep no
-- value. Length is capped by server-side validation plus maxLength in the
-- openapi (no CHECK constraint), matching visitor.vendor_name_override.
-- =============================================================================

ALTER TABLE visitor ADD COLUMN jabatan text NULL;

COMMENT ON COLUMN visitor.jabatan IS 'Jabatan anggota pengunjung yang diketik bebas (mis. Teknisi, Mandor, Supervisor); TIDAK terdaftar di katalog dan hanya dipakai sebagai saran isian (bukan enumerasi)';
