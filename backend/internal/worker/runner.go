package worker

import (
	"context"
	"log/slog"
	"os"
	"time"
)

// DefaultInterval is the auto-rule sweep period when WORKER_INTERVAL is
// absent: one sweep per 15 minutes. The 7-day, 2-hour and 24-hour rule horizons
// are absolute instants, so this tick can never skip a transition; the shorter
// period exists so the R4 reminder window (ReminderWindow) is polled often
// enough not to miss a visit that enters it between ticks.
const DefaultInterval = 15 * time.Minute

// intervalEnv names the variable configuring the sweep period as a Go
// duration (for example "30m", "1h"). Malformed values fall back to the
// default rather than stalling the worker.
const intervalEnv = "WORKER_INTERVAL"

// Sweeper runs one automatic-rule sweep. *Service satisfies it, so
// production passes the real service and tests pass a counting fake.
type Sweeper interface {
	Run(ctx context.Context) Summary
}

// Runner ticks a Sweeper on a configured interval in-process: the PRD
// mandates native goroutines, not cron or Redis. It stops cleanly when the
// context is cancelled.
type Runner struct {
	sweep    Sweeper
	interval time.Duration
	logger   *slog.Logger
}

// NewRunner wires the ticker. A nil sweeper is replaced by an unwired service
// that reports missing dependencies through the Summary instead of panicking
// on tick. A non-positive interval falls back to DefaultInterval; a nil
// logger falls back to slog.Default.
func NewRunner(sweep Sweeper, interval time.Duration, logger *slog.Logger) *Runner {
	if sweep == nil {
		sweep = NewService(Dependencies{})
	}
	if interval <= 0 {
		interval = DefaultInterval
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &Runner{sweep: sweep, interval: interval, logger: logger}
}

// IntervalFromEnv reads the sweep period from WORKER_INTERVAL, defaulting to
// DefaultInterval when absent or malformed.
func IntervalFromEnv() time.Duration {
	raw := os.Getenv(intervalEnv)
	if raw == "" {
		return DefaultInterval
	}
	parsed, err := time.ParseDuration(raw)
	if err != nil || parsed <= 0 {
		return DefaultInterval
	}
	return parsed
}

// Interval reports the configured tick period.
func (r *Runner) Interval() time.Duration {
	return r.interval
}

// Start runs the sweep immediately and then on every tick, logging each
// Summary at Info, until the context is cancelled. It blocks; the caller
// runs it in its own goroutine.
func (r *Runner) Start(ctx context.Context) {
	r.tick(ctx)
	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			r.logger.Info("auto-rule runner stopped")
			return
		case <-ticker.C:
			r.tick(ctx)
		}
	}
}

// tick executes one sweep and logs its outcome at Info.
func (r *Runner) tick(ctx context.Context) {
	summary := r.sweep.Run(ctx)
	r.logger.Info("auto-rule tick finished",
		"cancelled", summary.Cancelled,
		"no_show", summary.NoShow,
		"completed", summary.Completed,
		"reminded", summary.Reminded,
		"skipped", summary.Skipped,
		"failures", len(summary.Failures))
}
