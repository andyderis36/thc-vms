-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000013 : Index penunjang daftar kunjungan (filter + urutan + cari)
--
-- SSOT            : docs/1. Entity Relationship Diagram (ERD).mermaid
-- Contract        : docs/4. openapi.yaml (GET /visits, q/sort_by/order)
-- Business rules  : docs/0. PRD - THC Visitor App.md (L109-L112 scoping)
-- Target engine   : PostgreSQL 18.6
--
-- LATAR BELAKANG (terukur, bukan dugaan)
--   Sebelum migrasi ini skema hanya punya indeks satu kolom: location_id,
--   status, start_date, visit_id, pic/vendor_user_id. Setiap daftar kunjungan
--   memfilter location_id + status + rentang start_date lalu MENGURUTKAN
--   created_at, sehingga PostgreSQL mengambil seluruh baris yang cocok
--   (Bitmap Heap Scan) lalu Sort. Pada 5.120 baris uji: Bitmap Heap 1.120 baris
--   + Sort top-N = 2,266 ms untuk LIMIT 10; query Count kembarannya memindai
--   ulang himpunan yang sama.
--
--   Migrasi ini menambah indeks komposit berakhiran (created_at DESC, id DESC)
--   supaya daftar default (urutan created_at desc) dapat dibaca langsung dari
--   indeks tanpa node Sort, dan indeks rentang start_date untuk filter tanggal
--   pos jaga. Kolom id ikut di akhir setiap indeks karena ORDER BY selalu
--   diakhiri `vr.id DESC` (paginasi LIMIT/OFFSET tidak boleh mengulang baris).
--
--   Pencarian bebas memakai ILIKE '%kata%' pada lima kolom teks; pola berawalan
--   wildcard tidak dapat memakai indeks B-tree, jadi kolom tersebut diberi
--   indeks GIN trigram (pg_trgm). Tanpa ini setiap pencarian = seq scan penuh.
--
-- CATATAN OPERASIONAL
--   CREATE INDEX biasa (bukan CONCURRENTLY) dipakai karena migrate berjalan di
--   dalam transaksi dan tabel MVP masih kecil. Bila kelak tabel sudah besar,
--   bangun indeks manual dengan CONCURRENTLY di jendela maintenance sebelum
--   deploy, lalu migrasi ini menjadi no-op karena seluruh pernyataan memakai
--   IF NOT EXISTS.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- visit_request: jalur baca daftar (default sort created_at DESC)
-- ---------------------------------------------------------------------------

-- Superadmin tanpa filter lokasi.
CREATE INDEX IF NOT EXISTS idx_visit_created
    ON visit_request (created_at DESC, id DESC);

-- Superadmin dengan filter status.
CREATE INDEX IF NOT EXISTS idx_visit_status_created
    ON visit_request (status, created_at DESC, id DESC);

-- Admin/security satu cabang, tanpa filter status.
CREATE INDEX IF NOT EXISTS idx_visit_location_created
    ON visit_request (location_id, created_at DESC, id DESC);

-- Admin/security satu cabang + filter status.
CREATE INDEX IF NOT EXISTS idx_visit_location_status_created
    ON visit_request (location_id, status, created_at DESC, id DESC);

-- Filter rentang tanggal (pos jaga "Hari Ini") dan sort_by=start_date.
CREATE INDEX IF NOT EXISTS idx_visit_location_start
    ON visit_request (location_id, start_date DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_visit_location_status_start
    ON visit_request (location_id, status, start_date DESC, id DESC);

-- Vendor: hanya kunjungan miliknya sendiri.
CREATE INDEX IF NOT EXISTS idx_visit_vendor_user_created
    ON visit_request (vendor_user_id, created_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- Pencarian teks (ILIKE '%...%') -> GIN trigram
-- ---------------------------------------------------------------------------

-- Visit ID bisa dicari sebagian ("VST-0000"), bukan hanya prefiks.
CREATE INDEX IF NOT EXISTS idx_visit_visit_id_trgm
    ON visit_request USING gin (visit_id gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_users_name_trgm
    ON users USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_vendor_name_trgm
    ON vendor USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_location_name_trgm
    ON location USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_purpose_name_trgm
    ON purpose USING gin (name gin_trgm_ops);

-- Pencarian nama anggota roster (subquery EXISTS pada daftar kunjungan).
CREATE INDEX IF NOT EXISTS idx_visitor_name_trgm
    ON visitor USING gin (name gin_trgm_ops);
