package repository

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"

	"thc-vms/backend/internal/config"
)

// NewPool builds a pgxpool.Pool from the process configuration. Every knob is
// read from cfg (which itself is env-driven with laptop-safe defaults);
// nothing is hardcoded here. It fails fast when the database cannot be reached.
func NewPool(ctx context.Context, cfg *config.Config) (*pgxpool.Pool, error) {
	poolCfg, err := pgxpool.ParseConfig(cfg.DB.DSN())
	if err != nil {
		return nil, fmt.Errorf("repository: parse database DSN: %w", err)
	}
	poolCfg.MaxConns = cfg.DB.MaxConns
	poolCfg.MinConns = cfg.DB.MinConns
	poolCfg.MinIdleConns = cfg.DB.MinIdleConns
	poolCfg.MaxConnLifetime = cfg.DB.MaxConnLifetime
	poolCfg.MaxConnLifetimeJitter = cfg.DB.MaxConnLifetimeJitter
	poolCfg.MaxConnIdleTime = cfg.DB.MaxConnIdleTime
	// ConnectTimeout is the DIAL budget (TCP + TLS + startup) for a single new
	// connection, not a pool-wait budget: pgx v5 exposes no pool-level acquire
	// timeout, so how long a caller waits for a free connection is bounded by
	// the per-request context it passes to Query/Exec/Ping. cfg.DB.AcquireTimeout
	// is therefore deliberately NOT wired here - conflating an acquire timeout
	// with a dial timeout was the original bug this fixes.
	poolCfg.ConnConfig.ConnectTimeout = cfg.DB.ConnectTimeout

	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		return nil, fmt.Errorf("repository: create connection pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("repository: ping database: %w", err)
	}
	return pool, nil
}
