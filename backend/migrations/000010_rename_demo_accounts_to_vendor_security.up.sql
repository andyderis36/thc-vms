-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000010 : Rename identitas akun demo (pic -> vendor, satpam -> security)
--
-- SSOT            : docs/1. Entity Relationship Diagram (ERD).mermaid (USERS)
--                   docs/4. openapi.yaml (User.email, User.name)
-- Business rules  : docs/0. PRD - THC Visitor App.md (RBAC 4-peran)
-- Target engine   : PostgreSQL 18.6
--
-- SCOPE NOTE
--   000006 mengganti NILAI role 'pic' -> 'vendor' dan 000009 menyelaraskan nama
--   kolom storage. Migrasi ini menyusul IDENTITAS akun demo warisan (email dan
--   label nama tampilan) agar konsisten: local-part 'pic*@thc.com' ->
--   'vendor*@thc.com', 'satpam*@thc.com' -> 'security*@thc.com', dan label
--   '(Satpam ...' -> '(Pengawas ...'. Total 20 baris (10 akun vendor + 10 akun
--   security) yang cocok pola; nilai role tetap 'vendor'/'security' dan TIDAK
--   diubah oleh migrasi ini.
--
-- DESIGN (locked by architecture review)
--   Semua perubahan lewat UPDATE murni - TIDAK ada DELETE dan TIDAK ada reseed.
--   users.id (uuid) tidak pernah disentuh, sehingga 70 foreign key
--   visit_request.vendor_user_id -> users(id) tetap valid tanpa backfill apa
--   pun. users.email bersifat UNIQUE (users_email_key), jadi UPDATE akan gagal
--   keras (SQLSTATE 23505) bila email target ternyata sudah terpakai - tidak
--   ada tabrakan yang tertelan diam-diam.
--
-- IDEMPOTENCY
--   Tiap regex hanya cocok dengan bentuk LAMA, sehingga UPDATE bersifat
--   idempoten: menjalankan ulang setelah sukses menjadi no-op. Akun di luar
--   pola (mis. deris@thc.net.id) dibiarkan apa adanya.
-- =============================================================================

-- 10 akun vendor: 'pic1a..pic5b@thc.com' -> 'vendor1a..vendor5b@thc.com'.
UPDATE users SET email = 'vendor' || substr(email, 4) WHERE email ~ '^pic[1-5][ab]@thc\.com$';

-- 10 akun security: 'satpam1a..satpam5b@thc.com' -> 'security1a..security5b@thc.com'.
-- 'satpam' (6 huruf) dibuang mulai posisi 7. deris@thc.net.id tidak cocok pola.
UPDATE users SET email = 'security' || substr(email, 7) WHERE email ~ '^satpam[1-5][ab]@thc\.com$';

-- Label nama tampilan petugas pos: '(Satpam ...' -> '(Pengawas ...'.
UPDATE users SET name = replace(name, '(Satpam ', '(Pengawas ') WHERE name LIKE '%(Satpam %';
