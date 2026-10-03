-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000006 DOWN : kembalikan RBAC role 'vendor' -> 'pic'
--
-- Membalik 000006_rename_pic_to_vendor.up.sql persis. Isi fungsi trigger
-- dikembalikan ke definisi 000001, hanya nilai role 'vendor' yang kembali
-- menjadi 'pic'. Catatan: token JWT yang terbit setelah migrasi up akan
-- membawa "role":"vendor" dan ditolak dengan 403 setelah down dijalankan;
-- operator harus login ulang (tidak ada migrasi token).
-- =============================================================================

-- 1. Kembalikan fungsi trigger ke definisi 000001 (nilai role 'pic').
--    Dilakukan sebelum UPDATE pada langkah 2 agar tidak ada baris role
--    bernama 'vendor' yang ditolak trigger selama transisi.
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

    ELSIF v_role_name = 'pic' THEN
        IF NEW.location_id IS NOT NULL THEN
            RAISE EXCEPTION
                'role pic must have location_id = NULL (external vendor staff belong to no facility), got %',
                NEW.location_id
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.type <> 'external' THEN
            RAISE EXCEPTION
                'role pic must have type = ''external'', got %', NEW.type
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

-- 2. Kembalikan baris role. users.role_id tidak tersentuh (id role tetap),
--    sehingga tidak ada user yang perlu diperbarui.
UPDATE role SET name = 'pic' WHERE name = 'vendor';

-- 3. Kembalikan CHECK constraint ke daftar 000001. Dilakukan setelah UPDATE
--    agar nilai 'pic' sudah diizinkan ketika ditulis.
ALTER TABLE role DROP CONSTRAINT chk_role_name;

ALTER TABLE role ADD CONSTRAINT chk_role_name
    CHECK (name IN ('super_admin', 'admin', 'security', 'pic'));

-- 4. Kembalikan komentar kolom users.nik ke teks 000002.
COMMENT ON COLUMN users.nik IS 'Nomor Induk Kependudukan (16 digit numerik) pemilik akun; wajib untuk role admin/pic, NULL untuk security/super_admin';
