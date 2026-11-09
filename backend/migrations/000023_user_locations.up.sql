-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000023 : Add user_locations join table (coverage of users.location_id)
--
-- Hybrid primary+coverage architecture: users.location_id stays forever as the
-- primary assignment; user_locations is the single source of scope truth for
-- multi-branch scoping (admin/security filtered by location_id). This migration
-- is purely additive: no ALTER/DROP of users or any other table.
--
-- Target engine   : PostgreSQL 18.6
-- =============================================================================

CREATE TABLE user_locations (
    user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    location_id uuid NOT NULL REFERENCES location (id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, location_id)
);

CREATE INDEX ON user_locations (location_id, user_id);

-- Idempotent backfill: seed one coverage row per existing user assignment.
-- ON CONFLICT DO NOTHING keeps re-runs (and partial backfills) safe.
INSERT INTO user_locations (user_id, location_id)
SELECT id, location_id FROM users WHERE location_id IS NOT NULL
ON CONFLICT DO NOTHING;
