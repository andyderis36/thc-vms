-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000009 : Rename schema object pic_user_id -> vendor_user_id
--
-- SSOT            : docs/1. Entity Relationship Diagram (ERD).mermaid (VISIT_REQUEST)
--                   docs/4. openapi.yaml (VisitDetail.vendor_user_id)
-- Business rules  : docs/0. PRD - THC Visitor App.md (RBAC 4-peran, multi-cabang)
-- Target engine   : PostgreSQL 18.6
--
-- SCOPE NOTE
--   000006 mengganti NILAI role 'pic' -> 'vendor' tetapi SENGAJA membiarkan nama
--   storage lama (visit_request.pic_user_id beserta index dan FK-nya) sebagai
--   sejarah. Migrasi ini menyelaraskan NAMA storage tersebut dengan vocabulary
--   yang kini dipakai seluruh kode (vendor_user_id). HANYA nama objek yang
--   berubah: tipe kolom, NULL-ability, FK, index, dan seluruh baris data TIDAK
--   berubah sedikit pun. visit_request.vendor_id (FK perusahaan vendor) adalah
--   kolom BERBEDA dan tidak disentuh sama sekali.
--
-- DESIGN (locked by architecture review)
--   Rename empat objek secara berurutan dan deterministik: kolom, lalu index
--   PRD L209, lalu constraint FK ke users(id), terakhir constraint NOT NULL.
--   Urutan ini dipilih agar tiap pernyataan hanya bergantung pada nama objek
--   hasil pernyataan sebelumnya.
--
-- IDEMPOTENCY
--   Keempat RENAME tidak memakai IF EXISTS (RENAME sengaja gagal keras bila
--   objek sumber tidak ada) supaya salah target/urutan langsung terdeteksi;
--   hanya DROP CONSTRAINT pada langkah (d) yang memakai IF EXISTS - alasannya
--   lihat komentar di blok (d).
-- =============================================================================

-- (a) Rename kolom utama yang merujuk ke akun user vendor. Seluruh query
--     repositori sudah memanggilnya vendor_user_id.
ALTER TABLE visit_request RENAME COLUMN pic_user_id TO vendor_user_id;

-- (b) Rename index PRD L209 agar konsisten dengan nama kolom baru.
ALTER INDEX idx_visit_pic RENAME TO idx_visit_vendor_user;

-- (c) Rename foreign key ke users(id) agar mencerminkan nama kolom baru.
ALTER TABLE visit_request RENAME CONSTRAINT visit_request_pic_user_id_fkey TO visit_request_vendor_user_id_fkey;

-- (d) PostgreSQL 18 menyimpan NOT NULL sebagai constraint bernama sungguhan
--     (pg_constraint.contype = 'n', auto-name '<tabel>_<kolom>_not_null') yang
--     TIDAK ikut berubah saat kolom di-rename. Setelah (a), constraint masih
--     bernama visit_request_pic_user_id_not_null; ia dilepas lalu di-assert
--     ulang supaya memperoleh auto-name baru
--     (visit_request_vendor_user_id_not_null). DROP memakai IF EXISTS karena
--     pada PostgreSQL < 18 NOT NULL BUKAN baris pg_constraint sama sekali,
--     sehingga tidak ada yang perlu dilepas dan SET NOT NULL tetap idempoten.
ALTER TABLE visit_request DROP CONSTRAINT IF EXISTS visit_request_pic_user_id_not_null;
ALTER TABLE visit_request ALTER COLUMN vendor_user_id SET NOT NULL;
