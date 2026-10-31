-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000016 : Add hidden highest role 'dev-superadmin'
--
-- SSOT            : docs/1. Entity Relationship Diagram (ERD).mermaid (ROLE)
-- Business rules  : One internal, global, always-active platform-operator
--                   account (backend/seeds). It passes every branch scope like
--                   super_admin, never appears in user-facing lists (repository
--                   post-filters every listing), and is never offered as a
--                   selectable role on any create/edit surface.
-- Target engine   : PostgreSQL 18.6
--
-- The requested role string uses a hyphen ('dev-superadmin'), unlike the
-- existing underscore vocabulary ('super_admin'). The hyphen is literal data,
-- not an operator, so it needs no quoting beyond the string literal.
-- =============================================================================

-- 1. Widen the role vocabulary first; the trigger below references the new
--    name, and the seeder upserts the row right after migrating.
ALTER TABLE role DROP CONSTRAINT IF EXISTS chk_role_name;

ALTER TABLE role ADD CONSTRAINT chk_role_name
    CHECK (name IN ('super_admin', 'dev-superadmin', 'admin', 'security', 'vendor'));

-- 2. The location invariant gains one branch: 'dev-superadmin' holds the same
--    global posture as 'super_admin' (location_id MUST be NULL). Every other
--    branch is byte-for-byte the 000006 wording so this diff carries only the
--    new role and no semantic drift.
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

    ELSIF v_role_name = 'dev-superadmin' THEN
        IF NEW.location_id IS NOT NULL THEN
            RAISE EXCEPTION
                'role dev-superadmin must have location_id = NULL (platform operator holds global scope), got %',
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
