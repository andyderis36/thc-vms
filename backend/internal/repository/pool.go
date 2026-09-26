package repository

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"

	"thc-vms/backend/internal/config"
)

// NewPool builds a pgxpool.Pool from the process configuration. Every knob is
// read from cfg (which itself is env-driven with PRD defaults); nothing is
// hardcoded here. It fails fast when the database cannot be reached.
func NewPool(ctx context.Context, cfg *config.Config) (*pgxpool.Pool, error) {
	poolCfg, err := pgxpool.ParseConfig(cfg.DB.DSN())
	if err != nil {
		return nil, fmt.Errorf("repository: parse database DSN: %w", err)
	}
	poolCfg.MaxConns = cfg.DB.MaxConns
	poolCfg.MinConns = cfg.DB.MinConns
	poolCfg.MaxConnLifetime = cfg.DB.MaxConnLifetime
	poolCfg.MaxConnIdleTime = cfg.DB.MaxConnIdleTime
	poolCfg.ConnConfig.ConnectTimeout = cfg.DB.AcquireTimeout

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
