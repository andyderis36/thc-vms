-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000013 : Teardown indeks daftar kunjungan.
--
-- Seluruh indeks yang dibuat migrasi up dihapus kembali. Ekstensi pg_trgm
-- SENGAJA TIDAK di-drop: ekstensi bersifat infrastruktur klaster dan mungkin
-- sudah dipasang operator untuk keperluan lain; menghapusnya berisiko
-- merusak objek di luar migrasi ini. Tanpa indeks trigram, ekstensi yang
-- tersisa tidak memakan ruang maupun biaya tulis.
-- =============================================================================

DROP INDEX IF EXISTS idx_visit_created;
DROP INDEX IF EXISTS idx_visit_status_created;
DROP INDEX IF EXISTS idx_visit_location_created;
DROP INDEX IF EXISTS idx_visit_location_status_created;
DROP INDEX IF EXISTS idx_visit_location_start;
DROP INDEX IF EXISTS idx_visit_location_status_start;
DROP INDEX IF EXISTS idx_visit_vendor_user_created;

DROP INDEX IF EXISTS idx_visit_visit_id_trgm;
DROP INDEX IF EXISTS idx_users_name_trgm;
DROP INDEX IF EXISTS idx_vendor_name_trgm;
DROP INDEX IF EXISTS idx_location_name_trgm;
DROP INDEX IF EXISTS idx_purpose_name_trgm;
DROP INDEX IF EXISTS idx_visitor_name_trgm;
