package repository

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// reaperSlotKey names the single-instance advisory lock (hashtext of this
// string): the same session-scoped Postgres mechanism infrastructure/migrate
// uses for its migration lock, under a different key so the two never
// contend. The slot is TRY-lock only — a replica that finds it held skips
// its pass instead of queueing behind a possibly-stuck peer.
const reaperSlotKey = "thc-vms-reaper"

// ReaperRepository is the PostgreSQL adapter for the worker reaper's
// database seam (worker.ReaperRepository; the cmd/server/main.go wiring is
// the compile-time proof). Queries are hand-written on purpose: two small
// statements with no generated shape, following audit_repository.go's
// pool.Query precedent, so no sqlc regeneration is involved.
type ReaperRepository struct {
	pool *pgxpool.Pool
}

// NewReaperRepository builds the adapter on the shared pool.
func NewReaperRepository(pool *pgxpool.Pool) *ReaperRepository {
	return &ReaperRepository{pool: pool}
}

// ListReferencedURLs returns every non-empty stored file URL the schema can
// point at, across the six columns the reaper's anti-join watches:
// visit_request.assignment_letter_url, visitor.id_card_photo_url,
// visitor.photo_url, check_in.photo_url, users.avatar_url and
// visit_work_photo.url. The reaper reverses each URL to an object key through
// ObjectKeyFromStoredURL, so raw stored values (never presigned links) are
// exactly what it needs.
func (r *ReaperRepository) ListReferencedURLs(ctx context.Context) ([]string, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT assignment_letter_url FROM visit_request WHERE assignment_letter_url IS NOT NULL AND assignment_letter_url <> ''
		UNION ALL
		SELECT id_card_photo_url    FROM visitor      WHERE id_card_photo_url    IS NOT NULL AND id_card_photo_url    <> ''
		UNION ALL
		SELECT photo_url            FROM visitor      WHERE photo_url            IS NOT NULL AND photo_url            <> ''
		UNION ALL
		SELECT photo_url            FROM check_in     WHERE photo_url            IS NOT NULL AND photo_url            <> ''
		UNION ALL
		SELECT avatar_url           FROM users        WHERE avatar_url           IS NOT NULL AND avatar_url           <> ''
		UNION ALL
		SELECT url                  FROM visit_work_photo WHERE url             IS NOT NULL AND url                  <> ''
	`)
	if err != nil {
		return nil, fmt.Errorf("repository: list referenced file URLs: %w", err)
	}
	defer rows.Close()
	var urls []string
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, fmt.Errorf("repository: scan referenced file URL: %w", err)
		}
		urls = append(urls, raw)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("repository: iterate referenced file URLs: %w", err)
	}
	return urls, nil
}

// TryLock takes the reaper's single-instance slot with a non-blocking
// advisory lock. The dedicated connection is HELD until release runs,
// because advisory locks are session-scoped: returning it to the pool first
// would leave the lock owned by an anonymous pooled session that later
// queries might borrow. release unlocks on that same connection and only
// then returns it to the pool; a process crash drops the connection and
// Postgres releases the lock with it, so a dead replica can never wedge the
// job. ok=false means another instance holds the slot right now.
func (r *ReaperRepository) TryLock(ctx context.Context) (func() error, bool, error) {
	conn, err := r.pool.Acquire(ctx)
	if err != nil {
		return nil, false, fmt.Errorf("repository: acquire reaper slot connection: %w", err)
	}
	var held bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock(hashtext($1))`, reaperSlotKey).Scan(&held); err != nil {
		conn.Release()
		return nil, false, fmt.Errorf("repository: try reaper advisory lock: %w", err)
	}
	if !held {
		conn.Release()
		return nil, false, nil
	}
	release := func() error {
		defer conn.Release()
		// The unlock must run on the SAME session that took the lock and
		// must run even when the pass's context is already cancelled —
		// hence context.Background(), exactly like migrate.go's unlock.
		if _, err := conn.Exec(context.Background(), `SELECT pg_advisory_unlock(hashtext($1))`, reaperSlotKey); err != nil {
			return fmt.Errorf("repository: release reaper advisory lock: %w", err)
		}
		return nil
	}
	return release, true, nil
}
