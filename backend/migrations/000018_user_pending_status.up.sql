-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000018 : Real pending status for never-approved self-registrations
--
-- SSOT            : docs/1. Entity Relationship Diagram (ERD).mermaid (USER)
-- Business rules  : Public self-registration (POST /auth/register) creates
--                   vendor accounts with status pending: they exist but cannot
--                   sign in until a superadmin flips them to active
--                   (PATCH /users/:id/status). Deactivation keeps writing
--                   inactive exactly as before, so veterans pushed into
--                   "Menunggu persetujuan" by the old inactive-as-pending
--                   overload stay untouched: NO data backfill here, existing
--                   inactive rows keep their value by design. The login gate
--                   maps pending (like inactive) to the 403 AccountPending
--                   refusal, while blacklisted and unknown values stay 401.
-- =============================================================================

ALTER TABLE users DROP CONSTRAINT chk_users_status;
ALTER TABLE users ADD CONSTRAINT chk_users_status CHECK (status IN ('active', 'pending', 'inactive', 'blacklisted'));
