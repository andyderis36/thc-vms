-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000009 DOWN : kembalikan vendor_user_id -> pic_user_id
--
-- SSOT            : docs/1. Entity Relationship Diagram (ERD).mermaid (VISIT_REQUEST)
-- Business rules  : docs/0. PRD - THC Visitor App.md (RBAC 4-peran, multi-cabang)
-- Target engine   : PostgreSQL 18.6
--
-- Membalik 000009_rename_pic_user_to_vendor_user.up.sql persis: HANYA nama
-- empat objek yang dikembalikan (kolom, index, FK, constraint NOT NULL); tipe,
-- NULL-ability, FK, index, dan seluruh baris data tidak berubah.
-- visit_request.vendor_id (FK perusahaan vendor) tidak disentuh.
--
-- CATATAN URUTAN (locked by architecture review)
--   Auto-name constraint NOT NULL pada PostgreSQL 18 mengikuti nama kolom pada
--   saat SET NOT NULL dijalankan. Karena itu kolom harus SUDAH bernama
--   pic_user_id sebelum SET NOT NULL di-assert ulang - kebalikan langkah (a)
--   dijalin ke dalam blok (d) di bawah, bukan diletakkan paling akhir.
-- =============================================================================

-- (d)+(a) Kebalikan langkah (d) dan (a): lepas constraint NOT NULL auto-nama
--     versi 'vendor', kembalikan nama kolom, lalu assert NOT NULL ulang supaya
--     constraint kembali bernama visit_request_pic_user_id_not_null. DROP
--     memakai IF EXISTS karena pada PostgreSQL < 18 NOT NULL bukan baris
--     pg_constraint.
ALTER TABLE visit_request DROP CONSTRAINT IF EXISTS visit_request_vendor_user_id_not_null;
ALTER TABLE visit_request RENAME COLUMN vendor_user_id TO pic_user_id;
ALTER TABLE visit_request ALTER COLUMN pic_user_id SET NOT NULL;

-- (c) Kebalikan foreign key ke users(id).
ALTER TABLE visit_request RENAME CONSTRAINT visit_request_vendor_user_id_fkey TO visit_request_pic_user_id_fkey;

-- (b) Kebalikan index PRD L209.
ALTER INDEX idx_visit_vendor_user RENAME TO idx_visit_pic;
