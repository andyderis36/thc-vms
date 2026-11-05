-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000019 : Admit the human-cancel notification type
--
-- SSOT            : docs/1. Entity Relationship Diagram (ERD).mermaid (NOTIFICATION)
--                   backend/internal/domain/notification.go (HumanCancelledNotification)
-- Business rules  : backend/internal/repository/visit_status.go UpdateStatus
--                   emits a visit_cancelled notice on every human-driven
--                   cancellation: a vendor cancelling its own visit notifies
--                   the branch staff, an admin/superadmin cancelling notifies
--                   the vendor. The automatic worker path keeps emitting
--                   visit_auto_cancelled through TransitionNotification.
--
-- SCOPE NOTE
--   Forward-only widening of chk_notification_type. The 8 values pinned by
--   migration 000008 stay byte-identical; visit_cancelled is appended as the
--   9th value. History is immutable: 000008 is untouched, and the down
--   migration restores the 8-value list.
-- =============================================================================

ALTER TABLE notification DROP CONSTRAINT IF EXISTS chk_notification_type;
ALTER TABLE notification ADD CONSTRAINT chk_notification_type CHECK (type IN (
    'visit_requested', 'visit_rescheduled', 'visit_check_in', 'visit_check_out',
    'visit_approved', 'visit_rejected', 'visit_reminder', 'visit_auto_cancelled', 'visit_cancelled'));
