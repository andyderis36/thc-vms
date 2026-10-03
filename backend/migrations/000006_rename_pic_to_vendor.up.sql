-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000006 : Rename RBAC role 'pic' -> 'vendor'
--
-- SSOT            : docs/1. Entity Relationship Diagram (ERD).mermaid (ROLE)
--                   docs/4. openapi.yaml (Role enum, ManagedUser.role)
-- Business rules  : docs/0. PRD - THC Visitor App.md (RBAC 4-peran)
-- Target engine   : PostgreSQL 18.6
--
-- Migration ini HANYA mengganti NILAI role (identifier 'pic' -> 'vendor').
-- Kapabilitas, hak akses, dan scoping cabang TIDAK BERUBAH: role 'vendor'
-- tetap akun external tanpa location_id yang hanya boleh melihat dan
-- mengelola kunjungan miliknya sendiri.
--
-- YANG SENGAJA TIDAK DISENTUH (nama storage/API dikunci):
--   visit_request.pic_user_id, kolom turunan pic_name/pic_email/pic_phone,
--   member API `pic_user`, dan helper turunan PicUserID /
--   ListVisitsForPIC / CountVisitsByPIC. "pic" pada nama-nama tersebut berarti
--   "pemohon/pengaju kunjungan" (Person In Charge), BUKAN nilai role, dan
--   kontrak FE yang memakainya tidak berubah dalam migrasi ini.
--
-- Dampak token lokal: claim `role` pada JWT berisi string role mentah (lihat
-- internal/infrastructure/jwt/service.go). Token yang terbit SEBELUM migrasi
-- ini membawa "role":"pic" dan sesudahnya tidak lagi cocok dengan role
-- manapun, sehingga RequireRoles/EffectiveScope menolaknya dengan 403. Tidak
-- ada migrasi token: cukup login ulang. Dampak ini dapat diterima untuk
-- lingkungan lokal; pada produksi wajib dikoordinasikan dengan jendela
-- logout massal.
-- =============================================================================

-- 1. Lepas CHECK constraint lama lebih dulu; bila tidak, UPDATE pada langkah 2
--    ditolak karena nilai 'vendor' belum ada dalam daftar yang diizinkan.
--    Nama chk_role_name dipertahankan supaya rujukan (dokumen, audit, sqlc)
--    tidak berubah. IF EXISTS membuat migrasi ini idempoten: aman dijalankan
--    ulang (mis. harness integrasi yang mengaplikasikan seluruh migrasi pada
--    database scratch yang sudah ada).
ALTER TABLE role DROP CONSTRAINT IF EXISTS chk_role_name;

-- 2. Pindahkan baris role yang sudah ada. Role dirujuk lewat role_id, jadi
--    TIDAK ada users.role_id yang perlu disentuh: satu UPDATE sudah cukup.
--    Dilakukan SEBELUM ADD CONSTRAINT agar baris 'pic' yang masih ada tidak
--    menabrak daftar nilai baru (urutan DROP -> UPDATE -> ADD membuat migrasi
--    ini aman dijalankan pada database yang sudah berisi baris role 'pic').
UPDATE role SET name = 'vendor' WHERE name = 'pic';

ALTER TABLE role ADD CONSTRAINT chk_role_name
    CHECK (name IN ('super_admin', 'admin', 'security', 'vendor'));

-- 3. Fungsi trigger harus mengenali nilai role yang baru, kalau tidak setiap
--    INSERT/UPDATE pada users akan jatuh ke cabang ELSE dan melempar
--    "unknown role name". Seluruh isi fungsi 000001 dikembalikan apa adanya;
--    HANYA nilai role dan teks pesan yang memuat 'pic' yang berubah, sehingga
--    diff migrasi ini persis cerminan rename dan tidak menyisipkan perubahan
--    semantik lain.
CREATE OR REPLACE FUNCTION enforce_user_location_invariant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_role_name text;
BEGIN
    SELECT r.name
      INTO v_role_name
      FROM role r
     WHERE r.id = NEW.role_id;

    IF v_role_name IS NULL THEN
        RAISE EXCEPTION
            'users.role_id % does not resolve to a role row', NEW.role_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF v_role_name = 'super_admin' THEN
        IF NEW.location_id IS NOT NULL THEN
            RAISE EXCEPTION
                'role super_admin must have location_id = NULL (central office holds global scope), got %',
                NEW.location_id
                USING ERRCODE = 'check_violation';
        END IF;

    ELSIF v_role_name = 'admin' THEN
        IF NEW.location_id IS NULL THEN
            RAISE EXCEPTION
                'role admin must be assigned to a branch/POP (location_id NOT NULL)'
                USING ERRCODE = 'check_violation';
        END IF;

    ELSIF v_role_name = 'security' THEN
        IF NEW.location_id IS NULL THEN
            RAISE EXCEPTION
                'role security must be stationed at a branch/POP (location_id NOT NULL)'
                USING ERRCODE = 'check_violation';
        END IF;

    ELSIF v_role_name = 'vendor' THEN
        IF NEW.location_id IS NOT NULL THEN
            RAISE EXCEPTION
                'role vendor must have location_id = NULL (external vendor staff belong to no facility), got %',
                NEW.location_id
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.type <> 'external' THEN
            RAISE EXCEPTION
                'role vendor must have type = ''external'', got %', NEW.type
                USING ERRCODE = 'check_violation';
        END IF;

    ELSE
        RAISE EXCEPTION
            'unknown role name "%"; add its invariant to enforce_user_location_invariant() before using it', v_role_name
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION enforce_user_location_invariant() IS
    'PRD L109-112 role/location invariant; raises check_violation so the branch-isolation rule holds even if a Go write path forgets the check.';

-- 4. Komentar kolom users.nik (diisi 000002) masih menyebut role 'pic' dan
--    terbaca apa adanya lewat katalog basis data. Selaraskan supaya
--    dokumentasi di dalam DB tidak bertentangan dengan chk_role_name.
COMMENT ON COLUMN users.nik IS 'Nomor Induk Kependudukan (16 digit numerik) pemilik akun; wajib untuk role admin/vendor, NULL untuk security/super_admin';
