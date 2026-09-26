-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000001 : Initial MVP schema
--
-- SSOT            : docs/1. Entity Relationship Diagram (ERD).mermaid (L30-135)
-- Contract        : docs/4. openapi.yaml   (schemas User/Location/Purpose/VisitDetail)
-- Business rules  : docs/0. PRD - THC Visitor App.md
-- Target engine   : PostgreSQL 18.6
--
-- SCOPE NOTE
--   Only the MVP tables of the ERD are created here - 11 in total: role, vendor,
--   location, purpose, users, visit_request, visitor, visit_purpose,
--   status_history, check_in, check_out. (README section 6 and the ERD preamble
--   both say "10 entitas MVP"; the ERD body actually defines 11 MVP tables and
--   all 11 are required by the openapi contracts, so the count here follows the
--   ERD body. The discrepancy is a documentation typo, not a missing table.)
--   The Phase 2 extension entities (FEEDBACK, INCIDENT_REPORT, NOTIFICATION,
--   AUDIT_LOG - ERD L141-178) are deliberately NOT created: PRD L48-57 places
--   them in Phase 2/3 and PRD L79-83 explicitly forbids self-service feature
--   creep.
--
-- TIMESTAMP NOTE
--   The ERD writes some audit columns as bare `timestamp` (ERD L34, L48-50,
--   L60, L104, L118). Every timestamp column is created as `timestamptz` so
--   that `DEFAULT now()` is timezone-correct for the WIB/WITA/WIT facilities
--   (ERD L69). Mermaid has no timestamp-with-time-zone notation, so this is a
--   faithful normalisation, not a deviation.
--
-- updated_at MAINTENANCE DECISION
--   `users.updated_at` and `visit_request.updated_at` are maintained by the
--   REPOSITORY LAYER, not by a database trigger. Every UPDATE statement in
--   internal/repository/db/queries/*.sql sets `updated_at = now()` explicitly
--   (see UpdateUserStatus, UpdateUserLastLogin, UpdateVisitStatus,
--   UpdateVisitSchedule). Rationale: a trigger would hide the write from the
--   query that performs it and would silently mask a forgotten column in code
--   review; the repository is the only writer of these tables, so there is no
--   second writer to defend against. (Contrast with
--   enforce_user_location_invariant() below, which IS a trigger because the
--   security invariant must not depend on any application code path.)
--
-- role SEED DECISION
--   The 4 role rows (super_admin, admin, security, pic) are NOT inserted here.
--   They are left to the seeds program (backend/seeds, invoked via
--   `go run seeds/main.go` per README section 5) which performs an idempotent
--   upsert keyed on role.name. Inserting them here would either duplicate the
--   seeds or make the migration non-idempotent. consequence: the database is
--   usable only after the seeds program has run at least once.
--
-- gen_random_uuid() is a PostgreSQL 13+ core function, so no pgcrypto
-- extension is required (extension would be dropped by the down migration).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- ROLE - ERD L30-35
-- -----------------------------------------------------------------------------
CREATE TABLE role (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text        NOT NULL,
    permissions jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT role_name_key UNIQUE (name),
    CONSTRAINT chk_role_name CHECK (name IN ('super_admin', 'admin', 'security', 'pic'))
);

COMMENT ON TABLE  role              IS 'RBAC role catalogue - ERD L30-35; seeded by backend/seeds';
COMMENT ON COLUMN role.permissions  IS 'Optional JSON capability bag; MVP authorisation is driven by role.name (PRD L109-112)';

-- -----------------------------------------------------------------------------
-- VENDOR - ERD L53-61
-- -----------------------------------------------------------------------------
CREATE TABLE vendor (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    name           text        NOT NULL,
    contact_person text,
    email          text,
    phone          text,
    is_blacklisted boolean     NOT NULL DEFAULT false,
    created_at     timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- LOCATION - ERD L63-71
-- -----------------------------------------------------------------------------
CREATE TABLE location (
    id        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    name      text        NOT NULL,
    type      text        NOT NULL,
    address   text,
    city      text,
    timezone  text        NOT NULL DEFAULT 'WIB',
    is_active boolean     NOT NULL DEFAULT true,

    -- ERD L66 + openapi L726-731 (pusat|cabang|pop|minipop).
    -- docs/5. LOCAL_DEV.md still uses the stale head_office/branch_office/mini_pop
    -- vocabulary; the ERD + OpenAPI contract win, so those values are rejected.
    CONSTRAINT chk_location_type CHECK (type IN ('pusat', 'cabang', 'pop', 'minipop')),
    -- ERD L69 + openapi L736-738.
    CONSTRAINT chk_location_timezone CHECK (timezone IN ('WIB', 'WITA', 'WIT'))
);

-- -----------------------------------------------------------------------------
-- PURPOSE - ERD L73-77
-- -----------------------------------------------------------------------------
CREATE TABLE purpose (
    id        uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
    name      text    NOT NULL,
    is_active boolean NOT NULL DEFAULT true
);

-- -----------------------------------------------------------------------------
-- USERS - ERD L37-51
-- Role/location pairing is NOT expressible as a CHECK (a CHECK cannot reference
-- another table) so it is enforced by enforce_user_location_invariant() below.
-- -----------------------------------------------------------------------------
CREATE TABLE users (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    name          text        NOT NULL,
    email         text        NOT NULL,
    password_hash text        NOT NULL,
    phone         text,
    role_id       uuid        NOT NULL REFERENCES role (id),
    location_id   uuid        REFERENCES location (id),
    type          text        NOT NULL,
    status        text        NOT NULL DEFAULT 'active',
    vendor_id     uuid        REFERENCES vendor (id),
    last_login    timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),

    -- ERD L40 "Indexed for fast login".
    CONSTRAINT users_email_key UNIQUE (email),
    -- ERD L45.
    CONSTRAINT chk_users_type CHECK (type IN ('internal', 'external')),
    -- ERD L46.
    CONSTRAINT chk_users_status CHECK (status IN ('active', 'inactive', 'blacklisted'))
);

-- -----------------------------------------------------------------------------
-- VISIT_SEQ - human-facing visit code generator.
-- The repository formats the human code as 'VST-' || lpad(nextval('visit_seq'), 10, '0')
-- which is exactly the VST-XXXXXXXXXX shape required by PRD L119 (manual-scan
-- fallback), openapi L832 and ERD L81. chk_visit_request_visit_id_format below
-- makes that format a database invariant.
-- -----------------------------------------------------------------------------
CREATE SEQUENCE visit_seq START WITH 1 INCREMENT BY 1;

-- -----------------------------------------------------------------------------
-- VISIT_REQUEST - ERD L79-94
-- -----------------------------------------------------------------------------
CREATE TABLE visit_request (
    id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    visit_id             text        NOT NULL,
    pic_user_id          uuid        NOT NULL REFERENCES users (id),
    vendor_id            uuid        REFERENCES vendor (id),
    location_id          uuid        NOT NULL REFERENCES location (id),
    start_date           timestamptz NOT NULL,
    end_date             timestamptz NOT NULL,
    is_multi_day         boolean     NOT NULL DEFAULT false,
    status               text        NOT NULL DEFAULT 'requested',
    assignment_letter_url text,
    is_nda_accepted      boolean     NOT NULL DEFAULT false,
    notes                text,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),

    -- ERD L81 "Indexed: VST-XXXXXXXXXX"; UNIQUE also guarantees the scan path
    -- (GetVisitByVisitCode) can never resolve two different visits.
    CONSTRAINT visit_request_visit_id_key UNIQUE (visit_id),
    -- PRD L133-153 state machine / openapi L589-599 VisitStatus enum.
    -- The stale 'pending' / 'checked_in' / 'checked_out' values are rejected.
    CONSTRAINT chk_visit_request_status CHECK (
        status IN ('requested', 'approved', 'visiting', 'completed',
                   'not_visit', 'rejected', 'cancelled', 'rescheduled')
    ),
    -- ERD L81 + PRD L119: VST- followed by exactly 10 digits. Blocks the stale
    -- 'VMS-' prefix used in docs/6. QA_CHECKLIST.md GATE-07.
    CONSTRAINT chk_visit_request_visit_id_format CHECK (visit_id ~ '^VST-[0-9]{10}$'),
    -- QA VISIT-04 (docs/6. QA_CHECKLIST.md L30): reversed dates are rejected by
    -- the API with HTTP 400; this CHECK makes the database the second line of
    -- defence for the same rule.
    CONSTRAINT chk_visit_request_date_order CHECK (end_date > start_date)
);

-- -----------------------------------------------------------------------------
-- VISITOR - ERD L96-105
-- -----------------------------------------------------------------------------
CREATE TABLE visitor (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    visit_request_id uuid        NOT NULL REFERENCES visit_request (id) ON DELETE CASCADE,
    name             text        NOT NULL,
    id_number        text        NOT NULL,
    phone            text        NOT NULL,
    id_card_photo_url text,
    photo_url        text,
    created_at       timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- VISIT_PURPOSE - ERD L107-110
-- -----------------------------------------------------------------------------
CREATE TABLE visit_purpose (
    visit_request_id uuid        NOT NULL REFERENCES visit_request (id) ON DELETE CASCADE,
    purpose_id       uuid        NOT NULL REFERENCES purpose (id),

    CONSTRAINT visit_purpose_pkey PRIMARY KEY (visit_request_id, purpose_id)
);

-- -----------------------------------------------------------------------------
-- STATUS_HISTORY - ERD L112-119
-- Every status write must append a row here in the same transaction (PRD L129).
-- -----------------------------------------------------------------------------
CREATE TABLE status_history (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    visit_request_id uuid       NOT NULL REFERENCES visit_request (id) ON DELETE CASCADE,
    status          text        NOT NULL,
    changed_by      uuid        REFERENCES users (id),
    changed_at      timestamptz NOT NULL DEFAULT now(),
    notes           text,

    -- Same closed vocabulary as visit_request.status (PRD L133-153) so a history
    -- row can never record a status the visit itself cannot hold.
    CONSTRAINT chk_status_history_status CHECK (
        status IN ('requested', 'approved', 'visiting', 'completed',
                   'not_visit', 'rejected', 'cancelled', 'rescheduled')
    )
);

-- -----------------------------------------------------------------------------
-- CHECK_IN - ERD L121-128
-- UNIQUE (visit_request_id) implements ERD L123 "1 visit = 1 check-in record" and
-- makes a double check-in physically impossible: the second INSERT raises
-- SQLSTATE 23505 and the transaction is aborted. Deliberately NO
-- "ON CONFLICT DO NOTHING" so the failure is loud rather than silent.
-- -----------------------------------------------------------------------------
CREATE TABLE check_in (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    visit_request_id uuid       NOT NULL,
    checked_in_at   timestamptz NOT NULL,
    checked_in_by   uuid        NOT NULL REFERENCES users (id),
    photo_url       text,
    badge_code      text,

    CONSTRAINT check_in_visit_request_id_key UNIQUE (visit_request_id),
    CONSTRAINT check_in_visit_request_id_fkey FOREIGN KEY (visit_request_id)
        REFERENCES visit_request (id) ON DELETE CASCADE
);

-- -----------------------------------------------------------------------------
-- CHECK_OUT - ERD L130-135
-- UNIQUE (visit_request_id) implements ERD L132 "1 visit = 1 check-out record".
-- -----------------------------------------------------------------------------
CREATE TABLE check_out (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    visit_request_id uuid        NOT NULL,
    checked_out_at   timestamptz NOT NULL,
    checked_out_by   uuid        NOT NULL REFERENCES users (id),

    CONSTRAINT check_out_visit_request_id_key UNIQUE (visit_request_id),
    CONSTRAINT check_out_visit_request_id_fkey FOREIGN KEY (visit_request_id)
        REFERENCES visit_request (id) ON DELETE CASCADE
);

-- =============================================================================
-- INDEXES
-- =============================================================================

-- PRD L206-209: the four MANDATED B-Tree indexes (names are contractual).
CREATE INDEX idx_visit_status   ON visit_request (status);        -- PRD L206
CREATE INDEX idx_visit_date     ON visit_request (start_date);    -- PRD L207
CREATE INDEX idx_visit_id_code  ON visit_request (visit_id);      -- PRD L208
CREATE INDEX idx_visit_pic      ON visit_request (pic_user_id);   -- PRD L209
-- Note: idx_visit_id_code is functionally redundant with the implicit
-- visit_request_visit_id_key index created by the UNIQUE constraint above. It is
-- created anyway because PRD L208 mandates the index by that exact name (the QR
-- / manual-scan lookup is an explicit, documented hot path).

-- Supporting indexes for the foreign keys the repository actually filters or
-- joins on (PostgreSQL does not index FK columns automatically).
CREATE INDEX idx_visitor_visit_request      ON visitor (visit_request_id);
CREATE INDEX idx_status_history_visit_request ON status_history (visit_request_id);
CREATE INDEX idx_users_role_id              ON users (role_id);
CREATE INDEX idx_users_location_id          ON users (location_id);
CREATE INDEX idx_visit_request_location     ON visit_request (location_id);

-- =============================================================================
-- ROLE / LOCATION INVARIANT TRIGGER  (PRD L109-112, ERD L44)
--
-- Hard security requirement: the Go layer must not be the only line of defence
-- for the branch-isolation invariant, because a single missed `if` in a handler
-- would leak another branch's visit data (AGENTS.md rule 7.4).
--
--   super_admin : location_id IS NULL                       (PRD L109)
--   admin       : location_id IS NOT NULL                    (PRD L110)
--   security    : location_id IS NOT NULL                    (PRD L111)
--   pic         : location_id IS NULL AND type = 'external'  (PRD L112)
--
-- A CHECK constraint cannot express this because the predicate depends on
-- role.name, which lives in another table. Hence BEFORE INSERT OR UPDATE.
-- =============================================================================
CREATE FUNCTION enforce_user_location_invariant()
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

CREATE TRIGGER trg_users_location_invariant
    BEFORE INSERT OR UPDATE OF role_id, location_id, type ON users
    FOR EACH ROW
    EXECUTE FUNCTION enforce_user_location_invariant();
