-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000024 : Teardown of visit_request.created_by and visit_work_photo.
--
-- A bare `000024 up; 000024 down` restores the 000001..000023 schema exactly.
-- The table goes first so its FK on visit_request is gone before the column
-- teardown touches the same table.
-- =============================================================================

DROP TABLE IF EXISTS visit_work_photo;

ALTER TABLE visit_request DROP COLUMN IF EXISTS created_by;
