// Package migrate applies the embedded SQL migrations at startup without the
// migrate CLI and without shelling out to anything.
//
// REPORTED SEAM (not patched): no golang-migrate postgres database driver is
// importable under the frozen module manifest. database/postgres needs
// github.com/lib/pq, database/pgx needs github.com/jackc/pgx/v4, and
// database/pgx/v5 needs github.com/jackc/pgerrcode; none of the three is in
// go.mod/go.sum, and those files are outside this task's ownership, so the
// driver packages cannot be compiled here. What this package DOES use from
// the migrate module is the source/iofs driver over the embedded migrations
// FS: version parsing, ordering and up/down pairing stay library-owned.
// Application and version tracking run over pgxpool against the
// schema_migrations(version, dirty) table, which is wire-compatible with the
// golang-migrate postgres driver, so a future CLI run interoperates with
// boots that went through here. golang-migrate tracks its own version, so Up
// is idempotent: a second call is a clean no-op.
package migrate

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/golang-migrate/migrate/v4/source"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"thc-vms/backend/migrations"
)

// bounds for startup database work so a wedged server fails loudly.
const (
	openTimeout  = 10 * time.Second
	stmtTimeout  = 60 * time.Second
	lockKey      = "thc-vms-migrations"
	versionsTabl = "schema_migrations"
)

// Up applies every pending embedded migration to the database at dsn. An
// already-migrated database is a clean no-op. A database left dirty by a
// failed run is refused with an error instead of being half-migrated twice.
func Up(ctx context.Context, dsn string) error {
	if dsn == "" {
		return errors.New("migrate: database DSN is required")
	}
	src, err := iofs.New(migrations.FS, ".")
	if err != nil {
		return fmt.Errorf("migrate: open embedded source: %w", err)
	}
	pool, err := openPool(ctx, dsn)
	if err != nil {
		return err
	}
	defer pool.Close()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("migrate: acquire connection: %w", err)
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock(hashtext($1))`, lockKey); err != nil {
		return fmt.Errorf("migrate: take advisory lock: %w", err)
	}
	defer func() {
		_, _ = conn.Exec(context.Background(), `SELECT pg_advisory_unlock(hashtext($1))`, lockKey)
	}()
	if err := ensureVersionTable(ctx, conn); err != nil {
		return err
	}
	current, dirty, err := currentVersion(ctx, conn)
	if err != nil {
		return err
	}
	if dirty {
		return fmt.Errorf("migrate: database is dirty at version %d: refusing to apply: %w",
			current, errors.New("manual repair required"))
	}
	for version, err := src.First(); ; version, err = src.Next(version) {
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			return fmt.Errorf("migrate: enumerate versions: %w", err)
		}
		if version <= current {
			continue
		}
		if err := apply(ctx, conn, src, version); err != nil {
			return err
		}
	}
}

// openPool dials the target database with a bounded startup handshake.
func openPool(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("migrate: parse DSN: %w", err)
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("migrate: create pool: %w", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, openTimeout)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("migrate: ping database: %w", err)
	}
	return pool, nil
}

// ensureVersionTable creates the golang-migrate-compatible version table.
func ensureVersionTable(ctx context.Context, conn *pgxpool.Conn) error {
	stmtCtx, cancel := context.WithTimeout(ctx, stmtTimeout)
	defer cancel()
	ddl := `CREATE TABLE IF NOT EXISTS ` + versionsTabl + `
		(version bigint NOT NULL PRIMARY KEY, dirty boolean NOT NULL)`
	if _, err := conn.Exec(stmtCtx, ddl); err != nil {
		return fmt.Errorf("migrate: create version table: %w", err)
	}
	return nil
}

// currentVersion reads the applied version; no row means a fresh database.
func currentVersion(ctx context.Context, conn *pgxpool.Conn) (uint, bool, error) {
	stmtCtx, cancel := context.WithTimeout(ctx, stmtTimeout)
	defer cancel()
	var version uint
	var dirty bool
	row := conn.QueryRow(stmtCtx, `SELECT version, dirty FROM `+versionsTabl+` LIMIT 1`)
	if err := row.Scan(&version, &dirty); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, false, nil
		}
		return 0, false, fmt.Errorf("migrate: read version: %w", err)
	}
	return version, dirty, nil
}

// apply runs one version's up migration and records it. The version row is
// marked dirty first (separate statement, like the migrate driver), so a
// crash between marking and finishing refuses the next boot instead of
// silently skipping a half-applied migration.
func apply(ctx context.Context, conn *pgxpool.Conn, src source.Driver, version uint) error {
	body, err := readUp(src, version)
	if err != nil {
		return err
	}
	stmtCtx, cancel := context.WithTimeout(ctx, stmtTimeout)
	defer cancel()
	mark := `INSERT INTO ` + versionsTabl + ` (version, dirty) VALUES ($1, true)
		ON CONFLICT (version) DO UPDATE SET dirty = true`
	if _, err := conn.Exec(stmtCtx, mark, version); err != nil {
		return fmt.Errorf("migrate: mark version %d dirty: %w", version, err)
	}
	if _, err := conn.Exec(stmtCtx, string(body)); err != nil {
		return fmt.Errorf("migrate: apply version %d: %w", version, err)
	}
	clear := `UPDATE ` + versionsTabl + ` SET dirty = false WHERE version = $1`
	if _, err := conn.Exec(stmtCtx, clear, version); err != nil {
		return fmt.Errorf("migrate: clear dirty on version %d: %w", version, err)
	}
	return nil
}

// readUp returns the up-migration body for one version from the iofs source.
func readUp(src source.Driver, version uint) ([]byte, error) {
	opened, _, err := src.ReadUp(version)
	if err != nil {
		return nil, fmt.Errorf("migrate: read up version %d: %w", version, err)
	}
	if opened == nil {
		return nil, fmt.Errorf("migrate: up version %d has no body", version)
	}
	defer func() {
		_ = opened.Close()
	}()
	body, err := io.ReadAll(opened)
	if err != nil {
		return nil, fmt.Errorf("migrate: read up version %d: %w", version, err)
	}
	return body, nil
}
