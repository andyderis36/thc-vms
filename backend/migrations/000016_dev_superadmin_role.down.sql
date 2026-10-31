-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000016 (DOWN) : Remove hidden highest role 'dev-superadmin'
--
-- Restores the 000006 trigger and the four-value chk_role_name. Data rows
-- carrying the removed role are left untouched (like the 000006 down, which
-- leaves renamed rows behind); re-upgrading re-admits them.
-- =============================================================================

ALTER TABLE role DROP CONSTRAINT IF EXISTS chk_role_name;

ALTER TABLE role ADD CONSTRAINT chk_role_name
    CHECK (name IN ('super_admin', 'admin', 'security', 'vendor'));

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
