-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000011 : Enforce at most one location of type 'pusat' (Kantor Pusat)
--
-- SSOT            : docs/1. Entity Relationship Diagram (ERD).mermaid (LOCATION)
--                   docs/4. openapi.yaml (Location.type)
-- Business rules  : docs/0. PRD - THC Visitor App.md (RBAC 4-peran, Kantor Pusat tunggal)
-- Target engine   : PostgreSQL 18.6
--
-- SCOPE NOTE
--   Kantor Pusat (type = 'pusat') adalah fasilitas tunggal kantor pusat THC.
--   Migrasi ini menambahkan partial unique index agar tidak ada dua baris
--   location dengan type = 'pusat'. Penulisan duplikat akan gagal dengan
--   SQLSTATE 23505 (unique_violation) pada constraint
--   uq_location_single_pusat, yang dipetakan Go ke domain.ErrConflict dengan
--   pesan "Kantor Pusat sudah terdaftar. Hanya boleh ada satu Kantor Pusat.".
--
-- GUARD
--   Jika data existing sudah memiliki lebih dari satu baris 'pusat', migrasi
--   ini GAGAL KERAS (RAISE EXCEPTION) dan TIDAK mengubah data apa pun.
--   Operator wajib merapikan duplikat secara manual (hapus atau ubah tipe
--   lokasi yang berlebih) sebelum menjalankan migrasi. Tidak ada demosi,
--   penghapusan, atau reklassifikasi otomatis.
-- =============================================================================
-- a) GUARD: abort if more than one 'pusat' row exists.
DO $$
DECLARE
    v_count integer;
    v_ids   text;
BEGIN
    SELECT count(*) INTO v_count
      FROM location
     WHERE type = 'pusat';

    IF v_count > 1 THEN
        SELECT string_agg(id::text, ', ' ORDER BY id) INTO v_ids
          FROM location
         WHERE type = 'pusat';

        RAISE EXCEPTION
            'Terdapat lebih dari satu Kantor Pusat (id: %s). Hanya boleh ada satu Kantor Pusat. Hapus atau ubah tipe lokasi yang berlebih secara manual sebelum menjalankan migrasi ini.',
            v_ids
            USING ERRCODE = 'check_violation';
    END IF;
END
$$;

-- b) Partial unique index: at most one 'pusat' row.
CREATE UNIQUE INDEX uq_location_single_pusat
    ON location (type)
    WHERE type = 'pusat';
