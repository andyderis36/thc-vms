package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Given a .env file with comments, blanks, an export prefix and quoted values,
// when it is loaded, then only the real KEY=VALUE pairs reach the environment.
func TestLoadDotEnv_ParsesCommentsBlanksExportsAndQuotes(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env")
	body := strings.Join([]string{
		"# a comment",
		"",
		"   ",
		"APP_NAME=THC-VMS-Backend",
		"export APP_PORT=8080",
		`S3_PUBLIC_BASE_URL="http://localhost:9000/thc-vms-bucket"`,
		"DB_NAME='thc_vms_db'",
	}, "\n")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	if err := LoadDotEnv(path); err != nil {
		t.Fatalf("LoadDotEnv must succeed: %v", err)
	}

	for key, want := range map[string]string{
		"APP_NAME":           "THC-VMS-Backend",
		"APP_PORT":           "8080",
		"S3_PUBLIC_BASE_URL": "http://localhost:9000/thc-vms-bucket",
		"DB_NAME":            "thc_vms_db",
	} {
		if got := os.Getenv(key); got != want {
			t.Errorf("%s = %q, want %q", key, got, want)
		}
	}
}

// The real process environment must win, so an operator can override any value
// without editing the file.
func TestLoadDotEnv_RealEnvironmentWins(t *testing.T) {
	t.Setenv("APP_NAME", "from-environment")
	path := filepath.Join(t.TempDir(), ".env")
	if err := os.WriteFile(path, []byte("APP_NAME=from-file\n"), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	if err := LoadDotEnv(path); err != nil {
		t.Fatalf("LoadDotEnv must succeed: %v", err)
	}
	if got := os.Getenv("APP_NAME"); got != "from-environment" {
		t.Fatalf("APP_NAME = %q, want the process environment to win", got)
	}
}

// A missing file is the normal container/CI case and must stay a no-op.
func TestLoadDotEnv_MissingFileIsNoOp(t *testing.T) {
	if err := LoadDotEnv(filepath.Join(t.TempDir(), "absent")); err != nil {
		t.Fatalf("a missing .env must be a no-op, got %v", err)
	}
}

// A malformed line must be reported: silently dropping it would surface later
// as an unrelated "JWT_SECRET is required" message.
func TestLoadDotEnv_MalformedLineIsReported(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env")
	if err := os.WriteFile(path, []byte("JWT_SECRET\n"), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	err := LoadDotEnv(path)
	if err == nil {
		t.Fatal("a line without '=' must be reported")
	}
	if !strings.Contains(err.Error(), "line 1") {
		t.Fatalf("error must name the line, got %v", err)
	}
}

// An unquoted value may carry a trailing comment.
func TestLoadDotEnv_StripsUnquotedTrailingComment(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env")
	if err := os.WriteFile(path, []byte("ALLOWED_MIME_TYPES=application/pdf,image/png # only these\n"), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	if err := LoadDotEnv(path); err != nil {
		t.Fatalf("LoadDotEnv must succeed: %v", err)
	}
	if got := os.Getenv("ALLOWED_MIME_TYPES"); got != "application/pdf,image/png" {
		t.Fatalf("ALLOWED_MIME_TYPES = %q, want the comment stripped", got)
	}
}

// Load must succeed using only a .env file, which is exactly the documented
// local runbook: copy .env.example to .env, then run the server.
func TestLoad_SucceedsFromDotEnvAlone(t *testing.T) {
	for _, key := range []string{"JWT_SECRET", "DB_USER", "DB_PASSWORD", "DB_NAME", "S3_ENDPOINT", "S3_BUCKET_NAME"} {
		t.Setenv(key, "")
		_ = os.Unsetenv(key)
	}
	// Load() resolves DotEnvFile relative to the working directory, so the
	// fixture has to live there - the same way the documented runbook does.
	t.Chdir(t.TempDir())

	body := strings.Join([]string{
		"JWT_SECRET=from-dot-env",
		"DB_USER=thc_user",
		"DB_PASSWORD=thc_password_local",
		"DB_NAME=thc_vms_db",
		"S3_ENDPOINT=localhost:9000",
		"S3_BUCKET_NAME=thc-vms-bucket",
	}, "\n")
	if err := os.WriteFile(DotEnvFile, []byte(body), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load must succeed from .env alone: %v", err)
	}
	if cfg.JWT.Secret != "from-dot-env" {
		t.Fatalf("JWT.Secret = %q, want the .env value", cfg.JWT.Secret)
	}
	if cfg.DB.Name != "thc_vms_db" || cfg.Storage.Bucket != "thc-vms-bucket" {
		t.Fatalf("database/storage not populated from .env: %+v", cfg.DB)
	}
}
