-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000024 : Add visit_request.created_by and visit_work_photo
--
-- SSOT            : docs/1. Entity Relationship Diagram (ERD).mermaid
--                   (VISIT_REQUEST, VISIT_WORK_PHOTO)
-- Business rules  : docs/0. PRD - THC Visitor App.md
-- Target engine   : PostgreSQL 18.6
--
-- created_by records the actor that submitted the visit request. Every legacy
-- row was submitted by the vendor account itself, so the backfill copies the
-- existing vendor_user_id. ON DELETE SET NULL keeps visit history intact when
-- an operator account is removed.
--
-- visit_work_photo stores exactly one "before" and one "after" evidence photo
-- per visit; UNIQUE (visit_request_id, kind) is the idempotency anchor, so a
-- re-upload replaces the row instead of accumulating duplicates.
--
-- SCOPE NOTE
--   Purely additive: no existing column, constraint or index is altered beyond
--   the new visit_request.created_by column.
-- =============================================================================

ALTER TABLE visit_request
    ADD COLUMN created_by uuid NULL REFERENCES users (id) ON DELETE SET NULL;

-- Idempotent backfill: one single statement, legacy rows were vendor-submitted.
UPDATE visit_request SET created_by = vendor_user_id WHERE created_by IS NULL;

CREATE TABLE visit_work_photo (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    visit_request_id uuid        NOT NULL REFERENCES visit_request (id) ON DELETE CASCADE,
    kind             text        NOT NULL,
    url              text        NOT NULL,
    uploaded_by      uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),

    -- Closed vocabulary: a visit has one proof of condition before and after.
    CONSTRAINT chk_visit_work_photo_kind CHECK (kind IN ('before', 'after')),
    CONSTRAINT uq_visit_work_photo_visit_kind UNIQUE (visit_request_id, kind)
);

CREATE INDEX idx_visit_work_photo_visit_request_id
    ON visit_work_photo (visit_request_id);
