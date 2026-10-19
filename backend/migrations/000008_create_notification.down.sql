-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000008 down : drop the persisted notification store.
--
-- The CASCADE-free DROP is deliberate: notification is a leaf table (nothing
-- references it), so a plain DROP is sufficient and safer than CASCADE.
-- =============================================================================

DROP TABLE IF EXISTS notification;
