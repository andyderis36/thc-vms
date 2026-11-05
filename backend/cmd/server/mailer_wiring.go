// Mailer wiring for the composition root: build once after the object
// store, inject as an OPTIONAL dependency (nil when SMTP is disabled), log
// exactly one boot line, and drain on graceful shutdown.
//
// The mailer stays optional so every existing boot path (CI, tests, SMTP
// unset) works unchanged: a nil domain.Mailer only disables email fan-out,
// it never fails a write. Construction performs no network I/O (the adapter
// dials per flush), so boot stays instant offline.
package main

import (
	"log/slog"

	"thc-vms/backend/internal/config"
	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/infrastructure/mailer"
)

// buildMailer constructs the SMTP adapter when enabled and returns (nil, nil)
// when disabled. A half-configured enabled mailer fails here (fail-fast,
// mirroring the storage adapter), never at the first notification. It never
// dials: the adapter opens a fresh SMTP connection per flush.
func buildMailer(cfg *config.Config) (*mailer.SMTPMailer, error) {
	if cfg == nil || !cfg.Mail.Enabled {
		return nil, nil
	}
	return mailer.New(cfg)
}

// mailerPort exposes a constructed adapter as the domain sending port. A nil
// adapter yields a nil port (not a typed-nil interface): services must see a
// true nil so their nil-skip stays bulletproof on the common disabled path.
func mailerPort(m *mailer.SMTPMailer) domain.Mailer {
	if m == nil {
		return nil
	}
	return m
}

// logMailerStatus emits exactly one boot line about the mailer state. The
// enabled line carries host:port for ops; user/password secrets never appear.
func logMailerStatus(cfg *config.Config) {
	if cfg != nil && cfg.Mail.Enabled {
		slog.Info("mailer enabled", "host", cfg.Mail.Host, "port", cfg.Mail.Port)
		return
	}
	slog.Info("mailer disabled")
}

// closeMailer drains the queued notifications before shutdown returns. A nil
// mailer is a no-op so the disabled path needs no guard at the call site.
func closeMailer(m *mailer.SMTPMailer) error {
	if m == nil {
		return nil
	}
	return m.Close()
}
