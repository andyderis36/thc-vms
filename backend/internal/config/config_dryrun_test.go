package config_test

import (
	"testing"

	"thc-vms/backend/internal/config"
)

// TestLoad_MailDryRunDefaultsFalse proves the no-network CI mode is opt-in:
// an unset SMTP_DRY_RUN never changes existing behavior.
func TestLoad_MailDryRunDefaultsFalse(t *testing.T) {
	clearEnv(t, configEnvKeys...)
	clearEnv(t, mailEnvKeys...)
	clearEnv(t, "SMTP_DRY_RUN")
	t.Setenv("JWT_SECRET", "unit-test-secret")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load() unexpected error: %v", err)
	}

	if cfg.Mail.DryRun {
		t.Error("Mail.DryRun = true, want false (SMTP_DRY_RUN unset must keep live dial behavior)")
	}
}

// TestLoad_MailDryRunParses proves SMTP_DRY_RUN=true arms the log-only mode
// the mail e2e relies on for CI legs without Mailpit.
func TestLoad_MailDryRunParses(t *testing.T) {
	clearEnv(t, configEnvKeys...)
	clearEnv(t, mailEnvKeys...)
	clearEnv(t, "SMTP_DRY_RUN")
	t.Setenv("JWT_SECRET", "unit-test-secret")
	t.Setenv("SMTP_DRY_RUN", "true")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load() unexpected error: %v", err)
	}

	if !cfg.Mail.DryRun {
		t.Error("Mail.DryRun = false, want true (SMTP_DRY_RUN=true must arm dry-run)")
	}
}

// TestLoad_MailDryRunRejectsMalformed proves a broken SMTP_DRY_RUN fails
// fast naming the variable instead of silently picking a mode.
func TestLoad_MailDryRunRejectsMalformed(t *testing.T) {
	clearEnv(t, configEnvKeys...)
	clearEnv(t, mailEnvKeys...)
	clearEnv(t, "SMTP_DRY_RUN")
	t.Setenv("JWT_SECRET", "unit-test-secret")
	t.Setenv("SMTP_DRY_RUN", "maybe")

	cfg, err := config.Load()
	if err == nil {
		t.Fatalf("Load() = %+v, want an error for SMTP_DRY_RUN=%q", cfg, "maybe")
	}
}
