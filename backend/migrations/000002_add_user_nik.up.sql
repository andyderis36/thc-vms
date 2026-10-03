-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000002 : Add users.nik (Nomor Induk Kependudukan)
--
-- SSOT            : docs/1. Entity Relationship Diagram (ERD).mermaid (USER)
-- Business rules  : NIK is the national identity number of admin/vendor account
--                   holders. It is mandatory for admin and vendor accounts
--                   (enforced in the Go usecase layer, mirroring the
--                   location/vendor pairing rules), and must stay NULL for
--                   security and super_admin accounts.
-- Target engine   : PostgreSQL 18.6
--
-- NULL passes a CHECK in PostgreSQL (NULL is not false), so the single CHECK
-- below constrains only populated values while leaving security/super_admin
-- rows NULL. Uniqueness holds across populated values only, exactly like
-- users_email_key does for email.
-- =============================================================================

ALTER TABLE users ADD COLUMN nik TEXT NULL UNIQUE;

ALTER TABLE users ADD CONSTRAINT chk_users_nik CHECK (nik ~ '^[0-9]{16}$');

COMMENT ON COLUMN users.nik IS 'Nomor Induk Kependudukan (16 digit numerik) pemilik akun; wajib untuk role admin/vendor, NULL untuk security/super_admin';
