// Command migrate applies pending embedded SQL migrations then exits.
//
// Prod companion to cmd/server: the server only auto-migrates when
// APP_ENV=local, so production (APP_ENV=production) runs this one-shot
// first — see docker-compose.prod.yml `migrate` service. Idempotent:
// an already-migrated database is a clean no-op; a dirty database
// refuses with an error instead of half-migrating twice.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"time"

	"thc-vms/backend/internal/config"
	inframigrate "thc-vms/backend/internal/infrastructure/migrate"
)

func main() {
	if err := run(); err != nil {
		slog.Error("thc-vms migrate failed", "err", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("load configuration: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if err := inframigrate.Up(ctx, cfg.DB.DSN()); err != nil {
		return fmt.Errorf("apply embedded migrations: %w", err)
	}
	slog.Info("database migrations complete", "db", cfg.DB.Name)
	return nil
}
