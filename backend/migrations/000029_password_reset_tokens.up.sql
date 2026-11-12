-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000029 : Self-service password reset tokens.
--
-- SSOT            : docs/0. PRD - THC Visitor App.md
-- Business rules  : docs/0. PRD - THC Visitor App.md
-- Target engine   : PostgreSQL 18.6
--
-- Stores SHA-256 hex digests of opaque, single-use password-reset tokens
-- issued for self-service password reset. The raw token is never persisted;
-- only its hash is stored, so a leaked database cannot be used to reset
-- passwords. A token is consumed by setting consumed_at in the same
-- transaction that updates the user's password.
--
-- SCOPE NOTE
--   Purely additive: one new table plus one index. No existing column,
--   constraint or index is altered.
-- =============================================================================

CREATE TABLE password_reset_tokens (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   text        NOT NULL UNIQUE,
    expires_at   timestamptz NOT NULL,
    consumed_at  timestamptz NULL,
    requested_ip text        NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_password_reset_tokens_token_hash
    ON password_reset_tokens (token_hash);
