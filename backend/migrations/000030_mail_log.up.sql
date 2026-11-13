-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000030 : Mail delivery log (observability of the async mailer)
--
-- SSOT            : docs/0. PRD - THC Visitor App.md
-- Business rules  : docs/0. PRD - THC Visitor App.md
-- Target engine   : PostgreSQL 18.6
--
-- mail_log records the verdict of EVERY mailer.Send call at the single flush
-- point (the SMTP worker in internal/infrastructure/mailer): one row per send
-- with its recipients, subject, lifecycle template label, queued/sent/failed
-- status, attempt count and final error text. It is PURE OBSERVABILITY: the
-- send/retry behaviour is untouched, writes are best-effort (a log failure
-- never fails a send), and the enqueue path never waits on the database (the
-- queued row is inserted from a detached goroutine; the verdict is upserted
-- by the worker that already runs off the request hot path).
--
-- html_body is DELIBERATELY NOT stored: the text body already carries the
-- full diagnosis and an HTML copy would only bloat the table (one row per
-- fan-out recipient). The subject line identifies the probe mails
-- ([EMAIL TES]) and the lifecycle mails alike.
--
-- SCOPE NOTE
--   Purely additive: one new table plus one index. No existing column,
--   constraint or index is altered.
-- =============================================================================

CREATE TABLE IF NOT EXISTS mail_log (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    recipients text[]      NOT NULL DEFAULT '{}',
    subject    text        NOT NULL,
    -- Lifecycle notification type (e.g. visit_approved) when the send went
    -- through the templated fan-out; empty for direct sends (test-mail probe,
    -- registration/email-change notices) which carry no NotificationType.
    template   text        NOT NULL DEFAULT '',
    status     text        NOT NULL DEFAULT 'queued'
        CONSTRAINT chk_mail_log_status CHECK (status IN ('queued', 'sent', 'failed')),
    attempts   int         NOT NULL DEFAULT 0,
    error      text        NULL,
    text_body  text        NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    sent_at    timestamptz NULL
);

CREATE INDEX IF NOT EXISTS idx_mail_log_status_created_at
    ON mail_log (status, created_at);
