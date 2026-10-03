package main

import (
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"
)

// envInt reads a positive integer tuning knob, falling back to def when the
// variable is absent, blank or unparsable. A malformed value must not stop the
// server: these knobs shape a rate limit, and refusing to boot over one would be
// a worse outcome than using the documented default. The fallback is logged so
// the operator can see the value was not honoured.
func envInt(key string, def int) int {
	raw := os.Getenv(key)
	if raw == "" {
		return def
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		slog.Warn("ignoring invalid tuning value, using default",
			"key", key, "value", raw, "default", def)
		return def
	}
	return value
}

// envList reads a comma-separated list knob (for example CORS origins).
// Absent or blank means "no values" (nil); entries are trimmed and empties
// dropped, so "a,, b" behaves like "a,b".
func envList(key string) []string {
	raw := os.Getenv(key)
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var out []string
	for _, part := range strings.Split(raw, ",") {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

// envDuration reads a Go duration tuning knob (for example "1m" or "30s") with
// the same fallback contract as envInt.
func envDuration(key string, def time.Duration) time.Duration {
	raw := os.Getenv(key)
	if raw == "" {
		return def
	}
	value, err := time.ParseDuration(raw)
	if err != nil || value <= 0 {
		slog.Warn("ignoring invalid tuning value, using default",
			"key", key, "value", raw, "default", def)
		return def
	}
	return value
}
