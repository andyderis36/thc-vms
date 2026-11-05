-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000021 : Add visitor.phone_edited
--                    (persistent edited marker for creator contact correction)
--
-- SSOT            : docs/1. Entity Relationship Diagram (ERD).mermaid (VISITOR)
-- Contract        : docs/4. openapi.yaml (VisitorItem.phone_edited,
--                   PATCH /visits/{id}/visitors/{visitorId})
-- Business rules  : docs/0. PRD - THC Visitor App.md
-- Target engine   : PostgreSQL 18.6
--
-- A visit creator (vendor owner) may correct an anggota member's phone number
-- before approval (visit status requested or rescheduled) via
-- PATCH /visits/{id}/visitors/{visitorId}. The corrected field leaves a
-- persistent marker so the gate staff can see the contact data was edited
-- after submission. Only the phone number may be corrected; the id_number
-- (KTP/SIM/passport) is immutable after submission.
--
-- The column is NOT NULL DEFAULT FALSE: every pre-existing roster row (and
-- every row inserted before the backend deploy) reads "never edited" without
-- a backfill. The flag is monotonic: once TRUE it never returns to FALSE,
-- and a no-change write leaves it untouched.
-- =============================================================================

ALTER TABLE visitor ADD COLUMN phone_edited boolean NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN visitor.phone_edited IS 'Penanda koreksi kontak anggota: TRUE bila nomor telepon pernah diubah pemilik kunjungan via PATCH /visits/{id}/visitors/{visitorId} sebelum approval; monoton (tidak pernah kembali FALSE)';
