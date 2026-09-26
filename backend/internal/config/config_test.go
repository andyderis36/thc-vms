package config_test

import (
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"thc-vms/backend/internal/config"
)

// configEnvKeys is every variable documented in docs/5. LOCAL_DEV.md section
// 4.1 plus the two pool knobs the PRD and auth diagram require. Tests unset
// all of them so each case starts from a known, empty environment.
var configEnvKeys = []string{
	"APP_NAME", "APP_ENV", "APP_PORT", "APP_DEBUG",
	"DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD", "DB_NAME", "DB_SSLMODE",
	"DB_MAX_CONNS", "DB_MIN_CONNS", "DB_MAX_CONN_LIFETIME",
	"DB_MAX_CONN_IDLE_TIME", "DB_ACQUIRE_TIMEOUT",
	"JWT_SECRET", "JWT_EXPIRATION_HOURS",
	"STORAGE_DRIVER", "S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY",
	"S3_BUCKET_NAME", "S3_USE_SSL", "S3_REGION", "S3_PUBLIC_BASE_URL",
	"MAX_UPLOAD_SIZE_MB", "ALLOWED_MIME_TYPES",
}

// clearEnv removes a variable for the duration of the test. t.Setenv registers
// the ambient value for restoration, then Unsetenv takes it away now.
func clearEnv(t *testing.T, keys ...string) {
	t.Helper()
	for _, key := range keys {
		t.Setenv(key, "")
		if err := os.Unsetenv(key); err != nil {
			t.Fatalf("Unsetenv(%q): %v", key, err)
		}
	}
}

func TestLoad_PoolDefaultsWhenEnvIsAbsent(t *testing.T) {
	// Given: an environment with no THC variables at all.
	// When:  the configuration is loaded.
	// Then:  the pgxpool knobs fall back to the PRD values:
	//        MaxConns 50, MinConns 10, MaxConnLifetime 1h,
	//        MaxConnIdleTime 15m, AcquireTimeout 5s.
	clearEnv(t, configEnvKeys...)
	t.Setenv("JWT_SECRET", "unit-test-secret")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load() unexpected error: %v", err)
	}

	if cfg.DB.MaxConns != 50 {
		t.Errorf("DB.MaxConns = %d, want 50", cfg.DB.MaxConns)
	}
	if cfg.DB.MinConns != 10 {
		t.Errorf("DB.MinConns = %d, want 10", cfg.DB.MinConns)
	}
	if cfg.DB.MaxConnLifetime != time.Hour {
		t.Errorf("DB.MaxConnLifetime = %s, want 1h", cfg.DB.MaxConnLifetime)
	}
	if cfg.DB.MaxConnIdleTime != 15*time.Minute {
		t.Errorf("DB.MaxConnIdleTime = %s, want 15m", cfg.DB.MaxConnIdleTime)
	}
	if cfg.DB.AcquireTimeout != 5*time.Second {
		t.Errorf("DB.AcquireTimeout = %s, want 5s", cfg.DB.AcquireTimeout)
	}
}

func TestLoad_RequiresJWTSecret(t *testing.T) {
	// Given: every other variable is present and valid.
	// When:  JWT_SECRET is missing, then present but blank.
	// Then:  both cases fail loudly - a signing key is never defaulted -
	//        and filling it in is the only thing that makes Load succeed.
	for _, tc := range []struct {
		name       string
		secret     string
		omitSecret bool
		wantErr    bool
	}{
		{name: "secret omitted", omitSecret: true, wantErr: true},
		{name: "secret present but empty", secret: "", wantErr: true},
		{name: "secret provided", secret: "a-real-signing-key", wantErr: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			clearEnv(t, configEnvKeys...)
			t.Setenv("JWT_SECRET", tc.secret)
			if tc.omitSecret {
				if err := os.Unsetenv("JWT_SECRET"); err != nil {
					t.Fatalf("Unsetenv: %v", err)
				}
			}

			cfg, err := config.Load()
			if tc.wantErr {
				if err == nil {
					t.Fatal("Load() = nil error, want a failure for a missing JWT_SECRET")
				}
				return
			}
			if err != nil {
				t.Fatalf("Load() unexpected error: %v", err)
			}
			if cfg.JWT.Secret != tc.secret {
				t.Errorf("JWT.Secret = %q, want %q", cfg.JWT.Secret, tc.secret)
			}
			if cfg.JWT.TTL() != 24*time.Hour {
				t.Errorf("JWT.TTL() = %s, want 24h", cfg.JWT.TTL())
			}
		})
	}
}

func TestLoad_UploadLimits(t *testing.T) {
	// Given: MAX_UPLOAD_SIZE_MB=5 and the three permitted MIME types.
	// When:  the configuration is loaded.
	// Then:  the megabyte value is converted to bytes and the allow-list is
	//        split into the three exact entries.
	clearEnv(t, configEnvKeys...)
	t.Setenv("JWT_SECRET", "unit-test-secret")
	t.Setenv("MAX_UPLOAD_SIZE_MB", "5")
	t.Setenv("ALLOWED_MIME_TYPES", "application/pdf,image/jpeg,image/png")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load() unexpected error: %v", err)
	}

	if cfg.Upload.MaxSizeMB != 5 {
		t.Errorf("Upload.MaxSizeMB = %d, want 5", cfg.Upload.MaxSizeMB)
	}
	if cfg.Upload.MaxSizeBytes != 5*1024*1024 {
		t.Errorf("Upload.MaxSizeBytes = %d, want %d", cfg.Upload.MaxSizeBytes, 5*1024*1024)
	}
	want := []string{"application/pdf", "image/jpeg", "image/png"}
	if !slices.Equal(cfg.Upload.AllowedMIMETypes, want) {
		t.Errorf("Upload.AllowedMIMETypes = %v, want %v", cfg.Upload.AllowedMIMETypes, want)
	}
}

func TestLoad_ParsesEveryTypedValue(t *testing.T) {
	// Given: explicit values for the app, pool, storage and upload groups.
	// When:  the configuration is loaded.
	// Then:  each field carries the parsed value, not the raw string.
	clearEnv(t, configEnvKeys...)
	for key, value := range map[string]string{
		"APP_NAME":              "THC-VMS-Backend",
		"APP_ENV":               "staging",
		"APP_PORT":              "9090",
		"APP_DEBUG":             "false",
		"DB_HOST":               "db.internal",
		"DB_PORT":               "6543",
		"DB_USER":               "vms",
		"DB_PASSWORD":           "not-a-real-password",
		"DB_NAME":               "vms_staging",
		"DB_SSLMODE":            "require",
		"DB_MAX_CONNS":          "120",
		"DB_MIN_CONNS":          "25",
		"DB_MAX_CONN_LIFETIME":  "90m",
		"DB_MAX_CONN_IDLE_TIME": "7m",
		"DB_ACQUIRE_TIMEOUT":    "3s",
		"JWT_SECRET":            "unit-test-secret",
		"JWT_EXPIRATION_HOURS":  "8",
		"STORAGE_DRIVER":        "s3",
		"S3_ENDPOINT":           "s3.example.internal:9000",
		"S3_ACCESS_KEY_ID":      "AKIAEXAMPLE",
		"S3_SECRET_ACCESS_KEY":  "not-a-real-secret",
		"S3_BUCKET_NAME":        "vms-bucket",
		"S3_USE_SSL":            "true",
		"S3_REGION":             "ap-southeast-1",
		"S3_PUBLIC_BASE_URL":    "https://cdn.example.internal/vms-bucket",
		"MAX_UPLOAD_SIZE_MB":    "12",
		"ALLOWED_MIME_TYPES":    "application/pdf",
	} {
		t.Setenv(key, value)
	}

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load() unexpected error: %v", err)
	}

	if cfg.App.Name != "THC-VMS-Backend" || cfg.App.Environment != "staging" {
		t.Errorf("App = %+v, want name THC-VMS-Backend env staging", cfg.App)
	}
	if cfg.App.Port != 9090 {
		t.Errorf("App.Port = %d, want 9090", cfg.App.Port)
	}
	if cfg.App.Debug {
		t.Error("App.Debug = true, want false")
	}
	if cfg.DB.MaxConns != 120 || cfg.DB.MinConns != 25 {
		t.Errorf("pool = %d/%d, want 120/25", cfg.DB.MaxConns, cfg.DB.MinConns)
	}
	if cfg.DB.MaxConnLifetime != 90*time.Minute || cfg.DB.MaxConnIdleTime != 7*time.Minute {
		t.Errorf("lifetime/idle = %s/%s, want 90m/7m", cfg.DB.MaxConnLifetime, cfg.DB.MaxConnIdleTime)
	}
	if cfg.DB.AcquireTimeout != 3*time.Second {
		t.Errorf("DB.AcquireTimeout = %s, want 3s", cfg.DB.AcquireTimeout)
	}
	if cfg.JWT.TTL() != 8*time.Hour {
		t.Errorf("JWT.TTL() = %s, want 8h", cfg.JWT.TTL())
	}
	if cfg.Storage.Driver != "s3" || cfg.Storage.Bucket != "vms-bucket" || !cfg.Storage.UseSSL {
		t.Errorf("Storage = %+v, want s3/vms-bucket/useSSL", cfg.Storage)
	}
	if cfg.Storage.PublicBaseURL != "https://cdn.example.internal/vms-bucket" {
		t.Errorf("Storage.PublicBaseURL = %q", cfg.Storage.PublicBaseURL)
	}
	if cfg.Upload.MaxSizeBytes != 12*1024*1024 {
		t.Errorf("Upload.MaxSizeBytes = %d, want %d", cfg.Upload.MaxSizeBytes, 12*1024*1024)
	}
}

func TestLoad_RejectsMalformedValues(t *testing.T) {
	// Given: one variable that cannot be parsed as its declared type.
	// When:  the configuration is loaded.
	// Then:  the failure names the offending variable instead of silently
	//        falling back to a default that would hide a broken deployment.
	for _, tc := range []struct{ name, key, value string }{
		{"port is not a number", "APP_PORT", "eighty-eighty"},
		{"pool size is not a number", "DB_MAX_CONNS", "many"},
		{"lifetime is not a duration", "DB_MAX_CONN_LIFETIME", "one hour"},
		{"acquire timeout is not a duration", "DB_ACQUIRE_TIMEOUT", "5 seconds"},
		{"expiration is not a number", "JWT_EXPIRATION_HOURS", "a day"},
		{"upload size is not a number", "MAX_UPLOAD_SIZE_MB", "big"},
		{"debug flag is not a boolean", "APP_DEBUG", "yes-please"},
		{"use ssl is not a boolean", "S3_USE_SSL", "sure"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			clearEnv(t, configEnvKeys...)
			t.Setenv("JWT_SECRET", "unit-test-secret")
			t.Setenv(tc.key, tc.value)

			cfg, err := config.Load()
			if err == nil {
				t.Fatalf("Load() = %+v, want an error for %s=%q", cfg, tc.key, tc.value)
			}
			if !strings.Contains(err.Error(), tc.key) {
				t.Errorf("error %q does not name the offending variable %q", err, tc.key)
			}
		})
	}
}

func TestDatabase_DSN(t *testing.T) {
	// Given: connection parts spread over individual variables.
	// When:  the DSN is assembled.
	// Then:  it is a valid postgres:// URL carrying every part, so the
	//        password never has to be hardcoded in Go source.
	clearEnv(t, configEnvKeys...)
	t.Setenv("JWT_SECRET", "unit-test-secret")
	t.Setenv("DB_HOST", "localhost")
	t.Setenv("DB_PORT", "5432")
	t.Setenv("DB_USER", "thc_user")
	t.Setenv("DB_PASSWORD", "unit-test-password")
	t.Setenv("DB_NAME", "thc_vms_db")
	t.Setenv("DB_SSLMODE", "disable")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load() unexpected error: %v", err)
	}

	want := "postgres://thc_user:unit-test-password@localhost:5432/thc_vms_db?sslmode=disable"
	if got := cfg.DB.DSN(); got != want {
		t.Errorf("DB.DSN() = %q, want %q", got, want)
	}
}
