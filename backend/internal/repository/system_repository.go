package repository

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

// systemRepository answers read-only observability probes over operational
// tables no feature writes through: schema_migrations is owned by the
// migrate adapter, so this adapter only reads its highest applied version.
// It satisfies the settings usecase AppliedVersionSource implicitly; no
// domain port is widened for one read-only probe.
type systemRepository struct {
	pool *pgxpool.Pool
}

// NewSystemRepository builds the read-only system probe adapter.
func NewSystemRepository(pool *pgxpool.Pool) *systemRepository {
	return &systemRepository{pool: pool}
}

// AppliedMaxVersion returns the highest applied migration version, or
// (nil, nil) when the version table is still empty (a fresh database before
// the first migrate run). The table name matches the migrate adapter's
// versionsTabl so both readers observe one version history; this probe never
// migrates, it only reads.
func (r *systemRepository) AppliedMaxVersion(ctx context.Context) (*int, error) {
	// COALESCE(-1) keeps the scan non-nullable: -1 is the "no row yet"
	// sentinel mapped to nil below, so pgx never has to scan SQL NULL.
	const q = `SELECT COALESCE(MAX(version), -1) FROM schema_migrations`
	var v int64
	if err := r.pool.QueryRow(ctx, q).Scan(&v); err != nil {
		return nil, MapError(err)
	}
	if v < 0 {
		return nil, nil
	}
	n := int(v)
	return &n, nil
}
