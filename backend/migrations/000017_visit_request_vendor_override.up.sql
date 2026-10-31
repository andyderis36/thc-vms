-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000017 : Visit-level manual vendor/mitra company
--
-- SSOT            : docs/1. Entity Relationship Diagram (ERD).mermaid
--                   (VISIT_REQUEST)
-- Contract        : docs/4. openapi.yaml (CreateVisitRequest.vendor_name,
--                   VisitDetail.vendor_name)
-- Business rules  : Admin/superadmin-created visits may name the visiting
--                   company directly on the visit row when the requesting
--                   vendor account has no company of its own.
--
-- The requesting vendor account keeps its own company untouched
-- (users.vendor_id / users.vendor_name_override): this column is the
-- per-visit manual company, honoured for the VisitDetail vendor_name display
-- only when present (trimmed, max 120 runes). It NEVER enters the vendor
-- catalogue: GET /vendors (ListActiveVendors) reads the vendor table only.
-- =============================================================================

ALTER TABLE visit_request ADD COLUMN vendor_name_override text;

COMMENT ON COLUMN visit_request.vendor_name_override IS 'Nama perusahaan vendor/mitra yang diketik manual per kunjungan (admin/superadmin); TIDAK terdaftar di katalog vendor dan TIDAK pernah tampil di dropdown vendor (hanya dipakai sebagai vendor_name tampilan bila terisi)';
