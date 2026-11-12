-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000029 (DOWN) : Teardown of password_reset_tokens.
-- =============================================================================

DROP TABLE IF EXISTS password_reset_tokens;
