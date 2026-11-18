-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000033 : visit_logs table for multi-entry permits + offsite status.
--
-- SSOT            : .omo/plans/multi-entry-permit.md (sections 2-4)
-- Target engine   : PostgreSQL 18.6
--
-- One row per gate entry (check-in = 'in', check-out = 'out'), written in the
-- same transaction as the status move. On-site presence stays derived from
-- visit_request.status = 'visiting'; this table is the per-entry timeline.
--
-- The two status CHECKs are widened with 'offsite' (checked-out, off site,
-- permit still active) so the new status is storable in both the visit row
-- and its history trail. No existing value is renamed or removed.
-- =============================================================================

ALTER TABLE visit_request
    DROP CONSTRAINT chk_visit_request_status,
    ADD CONSTRAINT chk_visit_request_status CHECK (
        status IN ('requested', 'approved', 'visiting', 'offsite', 'completed',
                   'not_visit', 'rejected', 'cancelled', 'rescheduled')
    );

ALTER TABLE status_history
    DROP CONSTRAINT chk_status_history_status,
    ADD CONSTRAINT chk_status_history_status CHECK (
        status IN ('requested', 'approved', 'visiting', 'offsite', 'completed',
                   'not_visit', 'rejected', 'cancelled', 'rescheduled')
    );

CREATE TABLE visit_logs (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    visit_request_id uuid        NOT NULL REFERENCES visit_request (id) ON DELETE CASCADE,
    direction        text        NOT NULL,
    actor_user_id    uuid        REFERENCES users (id),
    actor_role       text,
    created_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT chk_visit_logs_direction CHECK (direction IN ('in', 'out'))
);

CREATE INDEX idx_visit_logs_visit_created
    ON visit_logs (visit_request_id, created_at);
