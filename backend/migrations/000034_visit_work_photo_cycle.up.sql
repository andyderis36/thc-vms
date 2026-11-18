-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000034 : visit_work_photo.visit_log_id (per-cycle evidence FK).
--
-- SSOT            : docs/1. Entity Relationship Diagram (ERD).mermaid
-- Target engine   : PostgreSQL 18.6
--
-- Adds a NULLABLE visit_log_id FK from visit_work_photo to visit_logs so a
-- proof can later be bound to the exact check-in/out cycle it was taken in.
-- Nullable + no backfill on purpose: existing before/after rows predate
-- per-cycle binding and stay valid; old rows keep visit_log_id NULL.
--
-- SCOPE NOTE
--   Purely additive: no existing column, constraint or index is altered.
--   UNIQUE (visit_request_id, kind) and the repository upsert are UNTOUCHED —
--   the per-cycle write path (attach with visit_log_id + relaxed uniqueness)
--   is still TODO. Until then the per-cycle view is the client-side join in
--   VisitLogsTimeline (nearest uploaded_at to the log row).
-- =============================================================================

ALTER TABLE visit_work_photo
    ADD COLUMN visit_log_id uuid NULL REFERENCES visit_logs (id) ON DELETE SET NULL;

CREATE INDEX idx_visit_work_photo_visit_log_id
    ON visit_work_photo (visit_log_id);
