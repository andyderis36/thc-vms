package worker

import (
	"os"
	"strconv"
	"strings"
	"time"
)

// Environment knobs for the pending-orphan reaper. Every one of them fails
// safe: a missing, malformed or hostile value must never arm live deletion
// nor shrink the grace window toward "delete everything".
const (
	// ReaperDryRunEnv arms (1) or disarms (0) real deletion. DEFAULT ON: an
	// absent or unrecognised value means log-only, and only an explicit
	// falsy token (0/false/no/off) turns live deletion on. First deploys
	// therefore only log what they WOULD delete until an operator flips it.
	ReaperDryRunEnv = "REAPER_DRY_RUN"
	// ReaperGraceEnv is the minimum object age before an unreferenced
	// pending/ object may be reaped, in whole hours. Default
	// DefaultReaperGrace; malformed, zero or negative values fall back to
	// the default — never to a zero grace, which would delete every
	// unreferenced pending object on the first tick.
	ReaperGraceEnv = "REAPER_GRACE_HOURS"
	// ReaperIntervalEnv is the tick period as a Go duration ("6h", "24h").
	// Default DefaultReaperInterval; absent or malformed falls back.
	ReaperIntervalEnv = "REAPER_INTERVAL"
)

// Defaults shared by the env parser and the constructor fallbacks.
const (
	// DefaultReaperGrace mirrors the runbook's 24-hour precision window
	// (docs/5. LOCAL_DEV.md §9: the reaper deletes pending/ objects that
	// are exactly aged out; the 7-day ILM rule is only the backstop).
	DefaultReaperGrace = 24 * time.Hour
	// DefaultReaperInterval makes the sweep nightly: one pass per 24h is
	// plenty for staging orphans whose grace window is itself 24h.
	DefaultReaperInterval = 24 * time.Hour
)

// ReaperConfig is one reaper's policy: how old an object must be before it
// may be reaped, and whether deletion is armed at all. The zero value is NOT
// a safe default — DryRun=false is live deletion — so construct it with
// ReaperConfigFromEnv, or set DryRun explicitly.
type ReaperConfig struct {
	Grace  time.Duration
	DryRun bool
}

// ReaperConfigFromEnv builds the policy from REAPER_DRY_RUN and
// REAPER_GRACE_HOURS, falling back to the safe defaults (dry-run ON, 24h
// grace) when either variable is absent or unusable.
func ReaperConfigFromEnv() ReaperConfig {
	return ReaperConfig{
		Grace:  reaperGraceFromEnv(),
		DryRun: reaperDryRunFromEnv(),
	}
}

// ReaperIntervalFromEnv reads REAPER_INTERVAL (a Go duration such as "6h"),
// falling back to DefaultReaperInterval when absent or malformed, mirroring
// IntervalFromEnv's never-stall behaviour.
func ReaperIntervalFromEnv() time.Duration {
	raw := strings.TrimSpace(os.Getenv(ReaperIntervalEnv))
	if raw == "" {
		return DefaultReaperInterval
	}
	parsed, err := time.ParseDuration(raw)
	if err != nil || parsed <= 0 {
		return DefaultReaperInterval
	}
	return parsed
}

// reaperGraceFromEnv parses REAPER_GRACE_HOURS as whole hours. Anything that
// is not a positive integer yields the 24h default rather than a wider or
// zero window.
func reaperGraceFromEnv() time.Duration {
	raw := strings.TrimSpace(os.Getenv(ReaperGraceEnv))
	if raw == "" {
		return DefaultReaperGrace
	}
	hours, err := strconv.Atoi(raw)
	if err != nil || hours <= 0 {
		return DefaultReaperGrace
	}
	return time.Duration(hours) * time.Hour
}

// reaperDryRunFromEnv returns false ONLY for an explicit falsy token. Absent,
// empty and unrecognised values all mean dry-run ON: live deletion must
// always be a deliberate, unambiguous act.
func reaperDryRunFromEnv() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(ReaperDryRunEnv))) {
	case "0", "false", "no", "off":
		return false
	default:
		return true
	}
}
