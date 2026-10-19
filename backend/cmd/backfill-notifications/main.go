// Command backfill-notifications replays existing visit history into the
// persisted notification store (migration 000008), so visits created before the
// store existed appear in their recipients' feeds, then exits.
//
// It is idempotent: every insert rides ON CONFLICT DO NOTHING, so a re-run is a
// no-op and an interrupted run can be resumed safely. Run it once after
// `migrate` in production and after the seeder in local dev (docs/5, docs/7).
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"time"

	"thc-vms/backend/internal/config"
	"thc-vms/backend/internal/repository"
)

func main() {
	if err := run(); err != nil {
		slog.Error("thc-vms backfill-notifications failed", "err", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("load configuration: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	pool, err := repository.NewPool(ctx, cfg)
	if err != nil {
		return fmt.Errorf("open database pool: %w", err)
	}
	defer pool.Close()

	replayed, err := repository.BackfillNotifications(ctx, pool)
	if err != nil {
		return fmt.Errorf("backfill notifications: %w", err)
	}
	slog.Info("notification backfill complete", "events_replayed", replayed, "db", cfg.DB.Name)
	return nil
}
