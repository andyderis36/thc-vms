package config_test

import (
	"strings"
	"testing"

	"thc-vms/backend/internal/config"
)

// A copied local .env (AUTH_RATE_LIMIT=-1 open mode) landing on the VPS must
// not silently disable the login + register throttles on the two most exposed
// unauthenticated endpoints. Production fails fast at boot instead.
func TestLoad_ProductionRefusesDisabledAuthRateLimiter(t *testing.T) {
	// Given: a production environment with the local-dev open-mode sentinel.
	// When:  the configuration is loaded.
	// Then:  boot is refused with an error naming AUTH_RATE_LIMIT.
	clearEnv(t, configEnvKeys...)
	t.Setenv("JWT_SECRET", "unit-test-secret")
	t.Setenv("APP_ENV", "production")
	t.Setenv("AUTH_RATE_LIMIT", "-1")

	_, err := config.Load()
	if err == nil {
		t.Fatal("production with AUTH_RATE_LIMIT=-1 must fail to load, got nil error")
	}
	if !strings.Contains(err.Error(), "AUTH_RATE_LIMIT") {
		t.Fatalf("the boot error must name the offending variable, got: %v", err)
	}
}

// The local dev open mode is untouched: -1 still boots fine outside
// production (the wiring keeps its warn log and nil limiters as-is).
func TestLoad_LocalAllowsDisabledAuthRateLimiter(t *testing.T) {
	// Given: a local environment with the open-mode sentinel.
	// When:  the configuration is loaded.
	// Then:  loading succeeds exactly as before.
	clearEnv(t, configEnvKeys...)
	t.Setenv("JWT_SECRET", "unit-test-secret")
	t.Setenv("APP_ENV", "local")
	t.Setenv("AUTH_RATE_LIMIT", "-1")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("local with AUTH_RATE_LIMIT=-1 must keep booting, got: %v", err)
	}
	if cfg.App.Environment != "local" {
		t.Fatalf("App.Environment = %q, want local", cfg.App.Environment)
	}
}
