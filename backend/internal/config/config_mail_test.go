package config_test

import (
	"strings"
	"testing"
	"time"

	"thc-vms/backend/internal/config"
)

// mailEnvKeys freezes the 8 SMTP variable names parallel tasks code against.
var mailEnvKeys = []string{
	"SMTP_ENABLED", "SMTP_HOST", "SMTP_PORT", "SMTP_USER",
	"SMTP_PASSWORD", "SMTP_FROM", "SMTP_FROM_NAME", "SMTP_TIMEOUT",
}

func TestLoad_MailDisabledByDefault(t *testing.T) {
	// Given: none of the SMTP variables are set.
	// When:  the configuration is loaded.
	// Then:  mail stays disabled with no error and no dial intent (empty host),
	//        so existing boots never break.
	clearEnv(t, configEnvKeys...)
	clearEnv(t, mailEnvKeys...)
	t.Setenv("JWT_SECRET", "unit-test-secret")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load() unexpected error: %v", err)
	}

	if cfg.Mail.Enabled {
		t.Error("Mail.Enabled = true, want false (SMTP optional by default)")
	}
	if cfg.Mail.Host != "" {
		t.Errorf("Mail.Host = %q, want empty (zero dial intent)", cfg.Mail.Host)
	}
	if cfg.Mail.Port != 465 {
		t.Errorf("Mail.Port = %d, want 465", cfg.Mail.Port)
	}
	if cfg.Mail.Timeout != 30*time.Second {
		t.Errorf("Mail.Timeout = %s, want 30s", cfg.Mail.Timeout)
	}
}

func TestLoad_MailRejectsMalformedPort(t *testing.T) {
	// Given: SMTP_PORT cannot be parsed as an integer.
	// When:  the configuration is loaded.
	// Then:  the failure names SMTP_PORT instead of silently defaulting.
	clearEnv(t, configEnvKeys...)
	clearEnv(t, mailEnvKeys...)
	t.Setenv("JWT_SECRET", "unit-test-secret")
	t.Setenv("SMTP_PORT", "abc")

	cfg, err := config.Load()
	if err == nil {
		t.Fatalf("Load() = %+v, want an error for SMTP_PORT=%q", cfg, "abc")
	}
	if !strings.Contains(err.Error(), "SMTP_PORT") {
		t.Errorf("error %q does not name the offending variable %q", err, "SMTP_PORT")
	}
}

func TestLoad_MailParsesTimeout(t *testing.T) {
	// Given: SMTP_TIMEOUT=15s.
	// When:  the configuration is loaded.
	// Then:  Mail.Timeout carries the parsed 15s duration.
	clearEnv(t, configEnvKeys...)
	clearEnv(t, mailEnvKeys...)
	t.Setenv("JWT_SECRET", "unit-test-secret")
	t.Setenv("SMTP_TIMEOUT", "15s")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load() unexpected error: %v", err)
	}

	if cfg.Mail.Timeout != 15*time.Second {
		t.Errorf("Mail.Timeout = %s, want 15s", cfg.Mail.Timeout)
	}
}

func TestLoad_MailFromFallsBackToUser(t *testing.T) {
	// Given: SMTP_USER is set but SMTP_FROM is empty.
	// When:  the configuration is loaded.
	// Then:  Mail.From stays empty in config; the SMTP_FROM -> SMTP_USER
	//        fallback is resolved by the mail adapter at construction-read
	//        time (Task 3, go-mail), not by config.
	clearEnv(t, configEnvKeys...)
	clearEnv(t, mailEnvKeys...)
	t.Setenv("JWT_SECRET", "unit-test-secret")
	t.Setenv("SMTP_USER", "noreply@example.internal")
	t.Setenv("SMTP_HOST", "smtp.example.internal")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load() unexpected error: %v", err)
	}

	if cfg.Mail.From != "" {
		t.Errorf("Mail.From = %q, want empty (adapter falls back to User)", cfg.Mail.From)
	}
	if cfg.Mail.User != "noreply@example.internal" {
		t.Errorf("Mail.User = %q, want noreply@example.internal", cfg.Mail.User)
	}
}

func TestLoad_MailFromNameDefaults(t *testing.T) {
	// Given: SMTP_FROM_NAME is unset, then set to a custom value.
	// When:  the configuration is loaded.
	// Then:  Mail.FromName defaults to "THC VMS" and honors the override.
	clearEnv(t, configEnvKeys...)
	clearEnv(t, mailEnvKeys...)
	t.Setenv("JWT_SECRET", "unit-test-secret")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load() unexpected error: %v", err)
	}
	if cfg.Mail.FromName != "THC VMS" {
		t.Errorf("Mail.FromName = %q, want default \"THC VMS\"", cfg.Mail.FromName)
	}

	t.Setenv("SMTP_FROM_NAME", "THC Kuitansi")
	cfg, err = config.Load()
	if err != nil {
		t.Fatalf("Load() unexpected error: %v", err)
	}
	if cfg.Mail.FromName != "THC Kuitansi" {
		t.Errorf("Mail.FromName = %q, want override \"THC Kuitansi\"", cfg.Mail.FromName)
	}
}

func TestLoad_MailEnabledRequiresHost(t *testing.T) {
	// Given: SMTP_ENABLED=true but no SMTP_HOST.
	// When:  the configuration is loaded.
	// Then:  Load fails fast naming SMTP_HOST, so a half-configured mailer
	//        can never boot silently disabled-looking.
	clearEnv(t, configEnvKeys...)
	clearEnv(t, mailEnvKeys...)
	t.Setenv("JWT_SECRET", "unit-test-secret")
	t.Setenv("SMTP_ENABLED", "true")

	cfg, err := config.Load()
	if err == nil {
		t.Fatalf("Load() = %+v, want a fail-fast error for enabled mail without a host", cfg)
	}
	if !strings.Contains(err.Error(), "SMTP_HOST") {
		t.Errorf("error %q does not name the offending variable %q", err, "SMTP_HOST")
	}
}
