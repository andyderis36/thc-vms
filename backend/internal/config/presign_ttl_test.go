package config_test

import (
	"os"
	"strings"
	"testing"
	"time"

	"thc-vms/backend/internal/config"
)

// presignEnvKeys is cleared so each case starts from a known environment.
var presignEnvKeys = []string{"JWT_SECRET", "S3_PRESIGN_TTL_MINUTES"}

// clearPresignEnv removes a variable for the duration of the test. t.Setenv
// registers the ambient value for restoration, then Unsetenv takes it away.
func clearPresignEnv(t *testing.T, keys ...string) {
	t.Helper()
	for _, key := range keys {
		t.Setenv(key, "")
		if err := os.Unsetenv(key); err != nil {
			t.Fatalf("Unsetenv(%q): %v", key, err)
		}
	}
}

// Given no S3_PRESIGN_TTL_MINUTES in the environment, when the configuration
// is loaded, then the presign TTL falls back to 15 minutes and stays
// positive.
func TestLoad_PresignTTLDefaultsTo15Minutes(t *testing.T) {
	clearPresignEnv(t, presignEnvKeys...)
	t.Setenv("JWT_SECRET", "unit-test-secret")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load() unexpected error: %v", err)
	}
	if cfg.Storage.PresignTTLMinutes != 15 {
		t.Errorf("Storage.PresignTTLMinutes = %d, want 15", cfg.Storage.PresignTTLMinutes)
	}
	if cfg.Storage.PresignTTL() != 15*time.Minute {
		t.Errorf("Storage.PresignTTL() = %s, want 15m", cfg.Storage.PresignTTL())
	}
}

// Given an explicit S3_PRESIGN_TTL_MINUTES, when the configuration is loaded,
// then the value is honoured and forwarded positive.
func TestLoad_PresignTTLHonoursExplicitValue(t *testing.T) {
	clearPresignEnv(t, presignEnvKeys...)
	t.Setenv("JWT_SECRET", "unit-test-secret")
	t.Setenv("S3_PRESIGN_TTL_MINUTES", "30")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load() unexpected error: %v", err)
	}
	if cfg.Storage.PresignTTL() != 30*time.Minute {
		t.Errorf("Storage.PresignTTL() = %s, want 30m", cfg.Storage.PresignTTL())
	}
}

// Given a missing, zero or negative S3_PRESIGN_TTL_MINUTES, when the TTL is
// resolved, then it is clamped to the positive default (the adapter refuses
// expiry <= 0, so a non-positive TTL must never be forwarded).
func TestPresignTTL_NeverNonPositive(t *testing.T) {
	for _, minutes := range []int{0, -5} {
		ttl := config.Storage{PresignTTLMinutes: minutes}.PresignTTL()
		if ttl <= 0 {
			t.Errorf("PresignTTL(%d) = %s, want positive", minutes, ttl)
		}
	}
	zeroTTL := (config.Storage{}).PresignTTL()
	if zeroTTL != 15*time.Minute {
		t.Errorf("zero Storage.PresignTTL() = %s, want 15m", zeroTTL)
	}

	clearPresignEnv(t, presignEnvKeys...)
	t.Setenv("JWT_SECRET", "unit-test-secret")
	t.Setenv("S3_PRESIGN_TTL_MINUTES", "0")
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load() unexpected error: %v", err)
	}
	if cfg.Storage.PresignTTL() <= 0 {
		t.Errorf("Storage.PresignTTL() = %s, want positive", cfg.Storage.PresignTTL())
	}
}

// Given a non-integer S3_PRESIGN_TTL_MINUTES, when the configuration is
// loaded, then the failure names the offending variable.
func TestLoad_PresignTTLRejectsMalformedValue(t *testing.T) {
	clearPresignEnv(t, presignEnvKeys...)
	t.Setenv("JWT_SECRET", "unit-test-secret")
	t.Setenv("S3_PRESIGN_TTL_MINUTES", "fifteen")

	cfg, err := config.Load()
	if err == nil {
		t.Fatalf("Load() = %+v, want an error for S3_PRESIGN_TTL_MINUTES=fifteen", cfg)
	}
	if !strings.Contains(err.Error(), "S3_PRESIGN_TTL_MINUTES") {
		t.Errorf("error %q does not name the offending variable", err)
	}
}
