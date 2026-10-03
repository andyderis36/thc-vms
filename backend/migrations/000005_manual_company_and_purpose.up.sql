-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000005 : Manual company names + free-typed visit purpose
--
-- SSOT            : docs/1. Entity Relationship Diagram (ERD).mermaid
--                   (VISITOR, VISIT_REQUEST, USER)
-- Contract        : docs/4. openapi.yaml (VisitorItem.vendor_name,
--                   CreateVisitRequest.purpose_note, VisitDetail.purpose_note,
--                   CreateManagedUserRequest.vendor_name,
--                   UpdateManagedUserRequest.vendor_name)
-- Business rules  : docs/0. PRD - THC Visitor App.md
-- Target engine   : PostgreSQL 18.6
--
-- Field crews on site often belong to a company that is NOT in the vendor
-- catalogue (one-off subcontractor, manual entry by the PIC/admin), and a
-- visit reason sometimes falls outside the purpose catalogue ("tujuan lain"
-- typed freely). All three columns below are NULLable TEXT so legacy rows
-- stay untouched:
--
--   visitor.vendor_name_override : per-technician manual company, honoured
--     only when visitor.vendor_id (000003) is absent; a sent vendor_id wins
--     and the manual text is discarded, never stored alongside it.
--   visit_request.purpose_note   : free-typed "tujuan lain" accompanying or
--     replacing the visit_purpose catalogue links.
--   users.vendor_name_override   : manual company of a PIC account, honoured
--     only when users.vendor_id is absent; same vendor-wins rule as above.
--
-- Katalog/dropdown vendor (GET /vendors, ListActiveVendors) TIDAK PERNAH
-- membaca kolom-kolom ini: dropdown hanya menampilkan vendor terdaftar
-- (vendor.is_blacklisted = false). Nilai manual hanya muncul sebagai
-- vendor_name tampilan pada respons yang sudah ter-resolve.
-- =============================================================================

ALTER TABLE visitor ADD COLUMN vendor_name_override text;

COMMENT ON COLUMN visitor.vendor_name_override IS 'Nama perusahaan vendor yang diketik manual per teknisi; TIDAK terdaftar di katalog vendor dan TIDAK pernah tampil di dropdown vendor (hanya dipakai sebagai vendor_name tampilan bila vendor_id absen)';

ALTER TABLE visit_request ADD COLUMN purpose_note text;

COMMENT ON COLUMN visit_request.purpose_note IS 'Tujuan kunjungan tambahan yang diketik bebas (tujuan lain); TIDAK terdaftar di katalog purpose dan TIDAK pernah tampil di dropdown tujuan';

ALTER TABLE users ADD COLUMN vendor_name_override text;

COMMENT ON COLUMN users.vendor_name_override IS 'Nama perusahaan vendor akun PIC yang diketik manual; TIDAK terdaftar di katalog vendor dan TIDAK pernah tampil di dropdown vendor (hanya dipakai sebagai vendor_name tampilan bila vendor_id absen)';
