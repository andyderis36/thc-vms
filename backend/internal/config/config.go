// Package config loads the backend runtime configuration from the process
// environment (docs/5. LOCAL_DEV.md section 4.1, plus the two pool knobs the
// PRD and auth diagram require). Every field is typed; only JWT_SECRET is
// mandatory, everything else falls back to the documented default. No secret,
// bucket name or URL is ever hardcoded here - local values live in
// .env.example and reach the process through the environment.
package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Defaults are the laptop-safe baseline (S4): a small pool that costs nothing
// when idle and never exhausts a developer Postgres max_connections. A modest
// VPS should raise MaxConns/MinConns via the environment (see .env.example);
// every value below is overridable except the fixed dial timeout.
const (
	defaultAppName   = "THC-VMS-Backend"
	defaultAppEnv    = "local"
	defaultAppPort   = 8080
	defaultDBHost    = "localhost"
	defaultDBPort    = 5432
	defaultDBSSLMode = "disable"

	defaultMaxConns     = 10
	defaultMinConns     = 0
	defaultMinIdleConns = 1
	// defaultMaxConnLifetime recycles connections well before a NAT/proxy idle
	// window can silently drop them; the jitter spreads the recycle so a fleet
	// of processes never reconnects in lockstep (thundering herd).
	defaultMaxConnLifetime       = 30 * time.Minute
	defaultMaxConnLifetimeJitter = 5 * time.Minute
	defaultMaxConnIdleTime       = 10 * time.Minute
	// defaultConnectTimeout is a DIAL budget (TCP + TLS + startup), not a pool
	// acquire timeout. pgx v5 has no pool-level acquire timeout; a request's
	// wait for a free connection is bounded by its own context. Retained as the
	// legacy default for the deprecated DB_ACQUIRE_TIMEOUT knob.
	defaultConnectTimeout = 5 * time.Second
	defaultAcquireTimeout = 5 * time.Second

	defaultJWTExpirationHours = 24

	defaultStorageDriver = "minio"
	defaultMaxUploadMB   = 5
	// defaultMaxUploadIngestMB is the transport ceiling for a raw upload before
	// compression, deliberately four times the 5 MB stored ceiling.
	defaultMaxUploadIngestMB = 20
	defaultAllowedMIMEs      = "application/pdf,image/jpeg,image/png"
	// defaultPresignTTLMinutes bounds how long a presigned file URL stays
	// fetchable. Short enough that a leaked <a>/<img> href dies quickly,
	// long enough for a guard to open it from the visit detail page.
	defaultPresignTTLMinutes = 15
)

// Config is the fully validated runtime configuration.
type Config struct {
	App     App
	DB      Database
	JWT     JWT
	Storage Storage
	Upload  Upload
}

// App carries the HTTP server settings.
type App struct {
	Name        string
	Environment string
	Port        int
	Debug       bool
}

// Database carries the pgxpool connection settings.
type Database struct {
	Host            string
	Port            int
	User            string
	Password        string
	Name            string
	SSLMode         string
	MaxConns        int32
	MinConns        int32
	MinIdleConns    int32
	MaxConnLifetime time.Duration
	// MaxConnLifetimeJitter randomizes MaxConnLifetime so connections created
	// together do not expire together.
	MaxConnLifetimeJitter time.Duration
	MaxConnIdleTime       time.Duration
	// ConnectTimeout is the fixed dial budget handed to the pgx driver. It is
	// deliberately not env-driven and never derived from AcquireTimeout.
	ConnectTimeout time.Duration
	// AcquireTimeout is Deprecated: pgx v5 exposes no pool-level acquire
	// timeout (pool waits are bounded by the per-request context). The knob is
	// parsed and preserved so existing .env files keep working, but it is NOT
	// wired into the pool and has no runtime effect.
	AcquireTimeout time.Duration
}

// DSN assembles the postgres:// URL the pgx driver dials, so the password
// only ever lives in the environment and is composed in exactly one place.
func (d Database) DSN() string {
	credentials := d.User
	if d.Password != "" {
		credentials += ":" + d.Password
	}
	dsn := fmt.Sprintf("postgres://%s@%s:%d/%s", credentials, d.Host, d.Port, d.Name)
	if d.SSLMode != "" {
		dsn += "?sslmode=" + d.SSLMode
	}
	return dsn
}

// JWT carries the token signing settings.
type JWT struct {
	Secret          string
	ExpirationHours int
}

// TTL converts the configured lifetime into a duration for the signer.
func (j JWT) TTL() time.Duration {
	return time.Duration(j.ExpirationHours) * time.Hour
}

// Storage carries the MinIO/S3 endpoint settings.
type Storage struct {
	Driver          string
	Endpoint        string
	AccessKeyID     string
	SecretAccessKey string
	Bucket          string
	UseSSL          bool
	Region          string
	PublicBaseURL   string
	// PresignTTLMinutes bounds the presigned file-URL lifetime minted for
	// GET /visits reads. Always > 0: Load clamps a missing or non-positive
	// value to defaultPresignTTLMinutes, and PresignTTL repeats the guard
	// for zero-value Configs built outside Load (tests).
	PresignTTLMinutes int
}

// PresignTTL converts the configured presign lifetime into a duration. A
// non-positive value can never escape: it falls back to the default, so a
// caller always forwards a positive expiry to IStorageService.PresignedURL
// (whose adapter refuses expiry <= 0).
func (s Storage) PresignTTL() time.Duration {
	if s.PresignTTLMinutes <= 0 {
		return time.Duration(defaultPresignTTLMinutes) * time.Minute
	}
	return time.Duration(s.PresignTTLMinutes) * time.Minute
}

// Upload carries the file policy enforced by the storage adapter. Two ceilings
// are intentional: MaxSizeBytes bounds what is STORED (after browser/server
// compression), MaxIngestBytes bounds the raw request body that is TRANSPORTED
// to the server.
type Upload struct {
	MaxSizeMB        int
	MaxSizeBytes     int64
	MaxIngestMB      int
	MaxIngestBytes   int64
	AllowedMIMETypes []string
}

// Load reads every variable, applies defaults, and fails on the first
// malformed value, naming the offending variable. A missing or empty
// JWT_SECRET is always an error: a signing key must never be defaulted.
//
// It first consults the optional .env file so the documented local runbook
// (docs/5. LOCAL_DEV.md section 5) works as written; a real environment
// variable always takes precedence over the file.
func Load() (*Config, error) {
	if err := LoadDotEnv(DotEnvFile); err != nil {
		return nil, err
	}

	appPort, err := intEnv("APP_PORT", defaultAppPort)
	if err != nil {
		return nil, err
	}
	appDebug, err := boolEnv("APP_DEBUG", true)
	if err != nil {
		return nil, err
	}

	dbPort, err := intEnv("DB_PORT", defaultDBPort)
	if err != nil {
		return nil, err
	}
	maxConns, err := intEnv("DB_MAX_CONNS", defaultMaxConns)
	if err != nil {
		return nil, err
	}
	minConns, err := intEnv("DB_MIN_CONNS", defaultMinConns)
	if err != nil {
		return nil, err
	}
	minIdleConns, err := intEnv("DB_MIN_IDLE_CONNS", defaultMinIdleConns)
	if err != nil {
		return nil, err
	}
	maxLifetime, err := durationEnv("DB_MAX_CONN_LIFETIME", defaultMaxConnLifetime)
	if err != nil {
		return nil, err
	}
	maxLifetimeJitter, err := durationEnv("DB_MAX_CONN_LIFETIME_JITTER", defaultMaxConnLifetimeJitter)
	if err != nil {
		return nil, err
	}
	maxIdleTime, err := durationEnv("DB_MAX_CONN_IDLE_TIME", defaultMaxConnIdleTime)
	if err != nil {
		return nil, err
	}
	acquireTimeout, err := durationEnv("DB_ACQUIRE_TIMEOUT", defaultAcquireTimeout)
	if err != nil {
		return nil, err
	}

	secret := os.Getenv("JWT_SECRET")
	if secret == "" {
		return nil, errors.New("JWT_SECRET is required: refusing to start without a token signing key")
	}
	jwtHours, err := intEnv("JWT_EXPIRATION_HOURS", defaultJWTExpirationHours)
	if err != nil {
		return nil, err
	}

	useSSL, err := boolEnv("S3_USE_SSL", false)
	if err != nil {
		return nil, err
	}

	maxSizeMB, err := intEnv("MAX_UPLOAD_SIZE_MB", defaultMaxUploadMB)
	if err != nil {
		return nil, err
	}

	maxIngestMB, err := intEnv("MAX_UPLOAD_INGEST_MB", defaultMaxUploadIngestMB)
	if err != nil {
		return nil, err
	}

	maxSizeBytes := int64(maxSizeMB) * 1024 * 1024
	maxIngestBytes := int64(maxIngestMB) * 1024 * 1024
	// Invariant: the transport ceiling is never below the stored ceiling. A
	// cap configured lower would make a legal stored file unuploadable, since
	// the raw request carrying it is refused before compression can shrink it.
	// Raising (never lowering) preserves the documented 5 MB stored policy.
	if maxIngestBytes < maxSizeBytes {
		maxIngestMB = maxSizeMB
		maxIngestBytes = maxSizeBytes
	}

	presignTTLMinutes, err := intEnv("S3_PRESIGN_TTL_MINUTES", defaultPresignTTLMinutes)
	if err != nil {
		return nil, err
	}
	if presignTTLMinutes <= 0 {
		presignTTLMinutes = defaultPresignTTLMinutes
	}

	return &Config{
		App: App{
			Name:        stringEnv("APP_NAME", defaultAppName),
			Environment: stringEnv("APP_ENV", defaultAppEnv),
			Port:        appPort,
			Debug:       appDebug,
		},
		DB: Database{
			Host:                  stringEnv("DB_HOST", defaultDBHost),
			Port:                  dbPort,
			User:                  os.Getenv("DB_USER"),
			Password:              os.Getenv("DB_PASSWORD"),
			Name:                  os.Getenv("DB_NAME"),
			SSLMode:               stringEnv("DB_SSLMODE", defaultDBSSLMode),
			MaxConns:              int32(maxConns),
			MinConns:              int32(minConns),
			MinIdleConns:          int32(minIdleConns),
			MaxConnLifetime:       maxLifetime,
			MaxConnLifetimeJitter: maxLifetimeJitter,
			MaxConnIdleTime:       maxIdleTime,
			ConnectTimeout:        defaultConnectTimeout,
			AcquireTimeout:        acquireTimeout,
		},
		JWT: JWT{
			Secret:          secret,
			ExpirationHours: jwtHours,
		},
		Storage: Storage{
			Driver:            stringEnv("STORAGE_DRIVER", defaultStorageDriver),
			Endpoint:          os.Getenv("S3_ENDPOINT"),
			AccessKeyID:       os.Getenv("S3_ACCESS_KEY_ID"),
			SecretAccessKey:   os.Getenv("S3_SECRET_ACCESS_KEY"),
			Bucket:            os.Getenv("S3_BUCKET_NAME"),
			UseSSL:            useSSL,
			Region:            os.Getenv("S3_REGION"),
			PublicBaseURL:     os.Getenv("S3_PUBLIC_BASE_URL"),
			PresignTTLMinutes: presignTTLMinutes,
		},
		Upload: Upload{
			MaxSizeMB:        maxSizeMB,
			MaxSizeBytes:     maxSizeBytes,
			MaxIngestMB:      maxIngestMB,
			MaxIngestBytes:   maxIngestBytes,
			AllowedMIMETypes: splitList(stringEnv("ALLOWED_MIME_TYPES", defaultAllowedMIMEs)),
		},
	}, nil
}

// stringEnv returns the variable or the default when it is absent or blank.
func stringEnv(key, def string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return def
}

// intEnv parses an integer variable, defaulting when absent and failing when
// malformed so a broken deployment can never hide behind a silent default.
func intEnv(key string, def int) (int, error) {
	raw := os.Getenv(key)
	if raw == "" {
		return def, nil
	}
	value, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil {
		return 0, fmt.Errorf("invalid %s=%q: must be an integer: %w", key, raw, err)
	}
	return value, nil
}

// durationEnv parses a Go duration variable such as 1h, 15m or 5s.
func durationEnv(key string, def time.Duration) (time.Duration, error) {
	raw := os.Getenv(key)
	if raw == "" {
		return def, nil
	}
	value, err := time.ParseDuration(strings.TrimSpace(raw))
	if err != nil {
		return 0, fmt.Errorf("invalid %s=%q: must be a Go duration like 1h, 15m or 5s: %w", key, raw, err)
	}
	return value, nil
}

// boolEnv parses a boolean variable.
func boolEnv(key string, def bool) (bool, error) {
	raw := os.Getenv(key)
	if raw == "" {
		return def, nil
	}
	value, err := strconv.ParseBool(strings.TrimSpace(raw))
	if err != nil {
		return false, fmt.Errorf("invalid %s=%q: must be true or false: %w", key, raw, err)
	}
	return value, nil
}

// splitList turns a comma-separated variable into its trimmed entries,
// dropping blanks so a trailing comma cannot widen an allow-list.
func splitList(raw string) []string {
	var out []string
	for _, item := range strings.Split(raw, ",") {
		if trimmed := strings.TrimSpace(item); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}
