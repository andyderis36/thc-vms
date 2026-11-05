ALTER TABLE notification DROP CONSTRAINT IF EXISTS chk_notification_type;
ALTER TABLE notification ADD CONSTRAINT chk_notification_type CHECK (type IN (
    'visit_requested', 'visit_rescheduled', 'visit_check_in', 'visit_check_out',
    'visit_approved', 'visit_rejected', 'visit_reminder', 'visit_auto_cancelled'));
