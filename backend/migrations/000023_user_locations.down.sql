-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000023 : Teardown of user_locations join table.
--
-- A bare `000023 up; 000023 down` restores the 000001..000022 schema exactly.
-- users.location_id (primary assignment) is untouched by this teardown.
-- =============================================================================

DROP TABLE IF EXISTS user_locations;
