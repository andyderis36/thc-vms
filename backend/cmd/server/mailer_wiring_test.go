package main

import (
	"bytes"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	"thc-vms/backend/internal/config"
)

// mailEnvKeys freezes the 7 SMTP variable names this wiring covers. Clearing
// all of them reproduces the default boot (SMTP optional, disabled).
var mailEnvKeys = []string{
	"SMTP_ENABLED", "SMTP_HOST", "SMTP_PORT", "SMTP_USER",
	"SMTP_PASSWORD", "SMTP_FROM", "SMTP_TIMEOUT",
}

// clearMailEnv unsets every SMTP variable so the test sees the default boot.
func clearMailEnv(t *testing.T) {
	t.Helper()
	for _, key := range mailEnvKeys {
		if err := os.Unsetenv(key); err != nil {
			t.Fatalf("Unsetenv(%s): %v", key, err)
		}
	}
}

// loadTestConfig loads the strict config with a throwaway signing key. The
// working directory (cmd/server) holds no .env, so the process env rules.
func loadTestConfig(t *testing.T) *config.Config {
	t.Helper()
	t.Setenv("JWT_SECRET", "test-signing-key")
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("config.Load(): %v", err)
	}
	return cfg
}

// captureSlog reroutes the default logger into a buffer for one test.
func captureSlog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return &buf
}

// TestBuildMailer_DisabledByDefault is the nil-mailer common path: with no
// SMTP variables set the server deps build with a nil mailer, the strict
// loader passes, and nothing attempts a dial (nil has no address to dial).
func TestBuildMailer_DisabledByDefault(t *testing.T) {
	clearMailEnv(t)
	cfg := loadTestConfig(t)
	if cfg.Mail.Enabled {
		t.Fatal("Mail.Enabled = true, want false (SMTP optional by default)")
	}

	start := time.Now()
	m, err := buildMailer(cfg)
	if err != nil {
		t.Fatalf("buildMailer() error = %v, want nil", err)
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("buildMailer() took %s, want instant (no dial at construction)", elapsed)
	}
	if m != nil {
		t.Fatalf("buildMailer() = %v, want nil when SMTP_ENABLED=false", m)
	}
	if err := closeMailer(m); err != nil {
		t.Fatalf("closeMailer(nil) error = %v, want nil", err)
	}
}

// TestLogMailerStatus_DisabledSingleLine pins the disabled boot log: exactly
// one line naming the disabled state, and never the password sentinel.
func TestLogMailerStatus_DisabledSingleLine(t *testing.T) {
	clearMailEnv(t)
	t.Setenv("SMTP_PASSWORD", "s3cr3t-sentinel")
	cfg := loadTestConfig(t)

	buf := captureSlog(t)
	logMailerStatus(cfg)

	lines := strings.Count(strings.TrimRight(buf.String(), "\n"), "\n") + 1
	if buf.Len() == 0 {
		t.Fatal("logMailerStatus() emitted no line, want exactly one")
	}
	if lines != 1 {
		t.Fatalf("logMailerStatus() emitted %d lines, want exactly one:\n%s", lines, buf.String())
	}
	if !strings.Contains(buf.String(), "mailer disabled") {
		t.Fatalf("disabled boot line does not name the state:\n%s", buf.String())
	}
	if strings.Contains(buf.String(), "s3cr3t-sentinel") {
		t.Fatalf("disabled boot line leaks the password:\n%s", buf.String())
	}
}

// TestLogMailerStatus_EnabledLogsHostPortNotSecrets pins the enabled boot
// log: host:port for ops, never user/password secrets.
func TestLogMailerStatus_EnabledLogsHostPortNotSecrets(t *testing.T) {
	clearMailEnv(t)
	t.Setenv("SMTP_ENABLED", "true")
	t.Setenv("SMTP_HOST", "smtp.example.internal")
	t.Setenv("SMTP_PORT", "587")
	t.Setenv("SMTP_USER", "mailer-user-sentinel")
	t.Setenv("SMTP_PASSWORD", "s3cr3t-sentinel")
	cfg := loadTestConfig(t)

	buf := captureSlog(t)
	logMailerStatus(cfg)

	if out := buf.String(); !strings.Contains(out, "smtp.example.internal") || !strings.Contains(out, "587") {
		t.Fatalf("enabled boot line misses host:port:\n%s", out)
	}
	if out := buf.String(); strings.Contains(out, "s3cr3t-sentinel") || strings.Contains(out, "mailer-user-sentinel") {
		t.Fatalf("enabled boot line leaks secrets:\n%s", out)
	}
}

// TestBuildMailer_EnabledDoesNotDial proves construction performs no network
// I/O: an unroutable TEST-NET-1 host still builds instantly offline, and the
// queue drains cleanly on close with no goroutine left behind.
func TestBuildMailer_EnabledDoesNotDial(t *testing.T) {
	clearMailEnv(t)
	t.Setenv("SMTP_ENABLED", "true")
	t.Setenv("SMTP_HOST", "192.0.2.1")
	cfg := loadTestConfig(t)

	start := time.Now()
	m, err := buildMailer(cfg)
	if err != nil {
		t.Fatalf("buildMailer() error = %v, want nil", err)
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("buildMailer() took %s, want instant (no dial at construction)", elapsed)
	}
	if m == nil {
		t.Fatal("buildMailer() = nil, want mailer when SMTP_ENABLED=true")
	}

	done := make(chan error, 1)
	go func() { done <- closeMailer(m) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("closeMailer() error = %v, want clean drain", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("closeMailer() did not return in 10s (goroutine leak)")
	}
}
