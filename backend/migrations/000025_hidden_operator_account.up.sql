-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000025 : Hidden operator account for andyderispas33@gmail.com
--
-- Production never runs the seeder, so the hidden 'dev-superadmin' role row
-- (upserted by backend/seeds) does not exist there and the operator account
-- andyderispas33@gmail.com is an ordinary super_admin — visible in every
-- user listing. This migration closes that drift WITHOUT seeding:
--   1. ensure the hidden role row exists (no-op where the seeder made it);
--   2. move the operator account onto it (no-op where absent, and skipped
--      when the account holds a branch location, since the 000016 trigger
--      requires dev-superadmin location_id IS NULL).
-- Idempotent: safe to re-apply; each statement is guarded.
-- =============================================================================

INSERT INTO role (name)
SELECT 'dev-superadmin'
WHERE NOT EXISTS (SELECT 1 FROM role WHERE name = 'dev-superadmin');

UPDATE users
SET role_id = (SELECT id FROM role WHERE name = 'dev-superadmin')
WHERE email = 'andyderispas33@gmail.com'
  AND location_id IS NULL
  AND role_id <> (SELECT id FROM role WHERE name = 'dev-superadmin');
