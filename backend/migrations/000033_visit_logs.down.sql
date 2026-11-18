-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000033 (DOWN) : Revert the visit_logs table and the offsite
-- status widening. Drops ONLY the objects this migration created.
--
-- NOTE: re-adding the pre-offsite CHECKs fails while any visit_request or
-- status_history row still holds 'offsite' (forward-only data). Move such
-- visits back to a pre-offsite status before downgrading.
-- =============================================================================

DROP TABLE IF EXISTS visit_logs;

ALTER TABLE status_history
    DROP CONSTRAINT IF EXISTS chk_status_history_status,
    ADD CONSTRAINT chk_status_history_status CHECK (
        status IN ('requested', 'approved', 'visiting', 'completed',
                   'not_visit', 'rejected', 'cancelled', 'rescheduled')
    );

ALTER TABLE visit_request
    DROP CONSTRAINT IF EXISTS chk_visit_request_status,
    ADD CONSTRAINT chk_visit_request_status CHECK (
        status IN ('requested', 'approved', 'visiting', 'completed',
                   'not_visit', 'rejected', 'cancelled', 'rescheduled')
    );
