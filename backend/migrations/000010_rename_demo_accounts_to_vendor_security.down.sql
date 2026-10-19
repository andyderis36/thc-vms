-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000010 DOWN : kembalikan identitas akun demo ke bentuk lama
--
-- SSOT            : docs/1. Entity Relationship Diagram (ERD).mermaid (USERS)
-- Business rules  : docs/0. PRD - THC Visitor App.md (RBAC 4-peran)
-- Target engine   : PostgreSQL 18.6
--
-- Membalik 000010_rename_demo_accounts_to_vendor_security.up.sql persis:
-- 'vendor*@thc.com' -> 'pic*@thc.com', 'security*@thc.com' -> 'satpam*@thc.com',
-- dan '(Pengawas ...' -> '(Satpam ...'. Semua lewat UPDATE murni - TIDAK ada
-- DELETE, TIDAK ada reseed. users.id (uuid) tidak diubah, sehingga 70 foreign
-- key visit_request.vendor_user_id -> users(id) tetap valid tanpa backfill, dan
-- karena users.email UNIQUE (users_email_key), UPDATE gagal keras (SQLSTATE
-- 23505) bila email target sudah terpakai. Tiap regex hanya cocok bentuk BARU,
-- jadi migrasi ini idempoten.
-- =============================================================================

-- 10 akun vendor kembali: 'vendor1a..vendor5b@thc.com' -> 'pic1a..pic5b@thc.com'.
-- 'vendor' (6 huruf) dibuang mulai posisi 7.
UPDATE users SET email = 'pic' || substr(email, 7) WHERE email ~ '^vendor[1-5][ab]@thc\.com$';

-- 10 akun security kembali: 'security1a..security5b@thc.com' -> 'satpam1a..satpam5b@thc.com'.
-- 'security' (8 huruf) dibuang mulai posisi 9. deris@thc.net.id tidak cocok pola.
UPDATE users SET email = 'satpam' || substr(email, 9) WHERE email ~ '^security[1-5][ab]@thc\.com$';

-- Label nama tampilan petugas pos kembali: '(Pengawas ...' -> '(Satpam ...'.
UPDATE users SET name = replace(name, '(Pengawas ', '(Satpam ') WHERE name LIKE '%(Pengawas %';
