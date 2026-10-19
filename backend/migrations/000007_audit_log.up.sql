-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000007 : Audit log (Phase 2 extension entity)
--
-- SSOT            : docs/1. Entity Relationship Diagram (ERD).mermaid (AUDIT_LOG L172-182)
-- Target engine   : PostgreSQL 18.6
--
-- SCOPE NOTE
--   000001 deliberately did NOT create the Phase 2 extension entities
--   (FEEDBACK, INCIDENT_REPORT, NOTIFICATION, AUDIT_LOG). This migration
--   creates ONLY audit_log - the append-only trail every status write and
--   auth event feeds. The other three Phase 2 entities remain uncreated.
--   status_history and users.last_login are NOT touched here.
--
-- TIMESTAMP NOTE
--   ERD L177 writes the column as bare `timestamptz` semantics ("timestamp");
--   it is created as `timestamptz NOT NULL DEFAULT now()` per the 000001
--   TIMESTAMP NOTE normalisation (faithful, not a deviation).
--
-- user_id NULLABILITY DECISION
--   The ERD marks user_id as a plain FK with no NOT NULL marker. It stays
--   NULLable so system-initiated rows (background auto-rule worker, which has
--   no acting user - same rationale as status_history.changed_by in
--   visits.sql InsertStatusHistory) can be recorded. The FK itself is plain
--   (no ON DELETE action): deleting a user must NOT silently wipe the audit
--   trail that references them, so operator tooling must reassign or retain
--   those rows explicitly instead.
-- =============================================================================

CREATE TABLE IF NOT EXISTS audit_log (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid        REFERENCES users (id),
    action     text        NOT NULL,
    entity     text        NOT NULL,
    entity_id  uuid,
    timestamp  timestamptz NOT NULL DEFAULT now(),
    ip         text,
    user_agent text,
    metadata   jsonb
);

COMMENT ON TABLE audit_log IS 'Append-only audit trail - ERD L172-182; one row per auditable action, never updated or deleted by application code';

CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_user_id   ON audit_log (user_id);
