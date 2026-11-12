-- Migration 000025 (DOWN) : revert the operator account to super_admin.
-- The role row is dropped only when no user references it, so rolling back
-- on a database where the seeder owns dev-superadmin users is a no-op for
-- the row itself.

UPDATE users
SET role_id = (SELECT id FROM role WHERE name = 'super_admin')
WHERE email = 'andyderispas33@gmail.com'
  AND role_id = (SELECT id FROM role WHERE name = 'dev-superadmin');

DELETE FROM role
WHERE name = 'dev-superadmin'
  AND NOT EXISTS (SELECT 1 FROM users WHERE users.role_id = role.id);
