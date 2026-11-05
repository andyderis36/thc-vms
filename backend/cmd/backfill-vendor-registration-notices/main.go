// Command backfill-vendor-registration-notices inserts one approval-queue
// row (migration 000020) per existing pending vendor account, so vendors
// registered before the queue existed appear in the superadmin approval
// feed, then exits.
//
// It is idempotent: the insert rides ON CONFLICT (vendor_user_id) DO
// NOTHING, so a re-run inserts 0 rows and an interrupted run can be
// resumed safely. It writes rows only and never sends email. Run it once
// after `migrate` in production and after the seeder in local dev.
//
// Run order per binding design: migrate up -> deploy backend -> backfill
// -> enable email.
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
		slog.Error("thc-vms backfill-vendor-registration-notices failed", "err", err)
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

	inserted, err := repository.BackfillVendorRegistrationNotices(ctx, pool)
	if err != nil {
		return fmt.Errorf("backfill vendor registration notices: %w", err)
	}
	slog.Info("vendor registration backfill complete", "inserted", inserted, "db", cfg.DB.Name)
	return nil
}
