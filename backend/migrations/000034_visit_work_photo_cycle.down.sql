-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000034 : teardown of visit_work_photo.visit_log_id.
-- =============================================================================

DROP INDEX IF EXISTS idx_visit_work_photo_visit_log_id;

ALTER TABLE visit_work_photo
    DROP COLUMN IF EXISTS visit_log_id;
