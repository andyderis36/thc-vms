-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000001 : Teardown of the initial MVP schema.
--
-- Reverse dependency order. Everything created by 000001_init_schema.up.sql is
-- removed here, so a bare `000001 up; 000001 down` leaves an empty public schema.
-- All statements use IF EXISTS so the file is safe to run against a partially
-- populated database.
-- =============================================================================

-- 1. Trigger before the table it is attached to, and the function before the
--    trigger that references it.
DROP TRIGGER IF EXISTS trg_users_location_invariant ON users;
DROP FUNCTION IF EXISTS enforce_user_location_invariant();

-- 2. Explicit index drops (the child tables below also drop their indexes
--    implicitly; these are listed so the teardown order is self-documenting).
DROP INDEX IF EXISTS idx_visit_request_location;
DROP INDEX IF EXISTS idx_users_location_id;
DROP INDEX IF EXISTS idx_users_role_id;
DROP INDEX IF EXISTS idx_status_history_visit_request;
DROP INDEX IF EXISTS idx_visitor_visit_request;
DROP INDEX IF EXISTS idx_visit_pic;
DROP INDEX IF EXISTS idx_visit_id_code;
DROP INDEX IF EXISTS idx_visit_date;
DROP INDEX IF EXISTS idx_visit_status;

-- 3. Leaf tables first: they reference visit_request / users / location / purpose.
DROP TABLE IF EXISTS check_out;
DROP TABLE IF EXISTS check_in;
DROP TABLE IF EXISTS status_history;
DROP TABLE IF EXISTS visit_purpose;
DROP TABLE IF EXISTS visitor;

-- 4. The visit table itself (all children above are already gone).
DROP TABLE IF EXISTS visit_request;

-- 5. Visit-code generator.
DROP SEQUENCE IF EXISTS visit_seq;

-- 6. users last among the reference tables: it is referenced by visit_request,
--    status_history, check_in and check_out.
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS purpose;
DROP TABLE IF EXISTS location;
DROP TABLE IF EXISTS vendor;
DROP TABLE IF EXISTS role;
