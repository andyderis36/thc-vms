// Package store is the PostgreSQL adapter for the seeder: it resolves the
// connection the runbook configures, opens one transaction, and writes the
// plan as upserts.
//
// It is split out of ../main.go for two reasons. docs/5. LOCAL_DEV.md L164
// invokes `go run seeds/main.go`, and `go run` compiles only the file it is
// named, so the command has to stay a single, small composition root; and the
// upsert rules are the part of this program that has to be right about the
// schema, so they get their own package and their own tests rather than riding
// along in a CLI file.
package store

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"thc-vms/backend/internal/config"

	"thc-vms/backend/seeds/seeddata"
)

// connectTimeout bounds the whole seed so a wrong host fails in seconds
// instead of hanging the runbook's first step.
const connectTimeout = 10 * time.Second

// ---------------------------------------------------------------- target ---

// Target is the connection the runbook configures. Nothing is hardcoded: user,
// password and database name come from the environment (docs/5. LOCAL_DEV.md
// 2.1), and the host/port/sslmode defaults are the local development values
// from the same document.
type Target struct {
	host, port, user, password, name, sslMode string
}

// ResolveTarget reads the environment, consulting the optional .env file first
// so the documented runbook in docs/5. LOCAL_DEV.md section 5 works verbatim:
// copy .env.example to .env, then `go run seeds/main.go`. A real environment
// variable still wins over the file. A missing credential is a refusal, not a
// guess: connecting to the wrong database is worse than a clear error, and no
// password default is ever hardcoded here.
func ResolveTarget() (Target, error) {
	if err := config.LoadDotEnv(config.DotEnvFile); err != nil {
		return Target{}, err
	}
	t := Target{
		host:    envOr("DB_HOST", "localhost"),
		port:    envOr("DB_PORT", "5432"),
		sslMode: envOr("DB_SSLMODE", "disable"),
	}
	var missing []string
	for _, field := range []struct {
		key string
		dst *string
	}{
		{"DB_USER", &t.user},
		{"DB_PASSWORD", &t.password},
		{"DB_NAME", &t.name},
	} {
		*field.dst = os.Getenv(field.key)
		if *field.dst == "" {
			missing = append(missing, field.key)
		}
	}
	if len(missing) > 0 {
		return Target{}, fmt.Errorf("missing environment variable(s): %s (docs/5. LOCAL_DEV.md 2.1)", strings.Join(missing, ", "))
	}
	return t, nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// DSN is the only form that carries the password, and it is never printed.
func (t Target) DSN() string {
	return (&url.URL{
		Scheme:   "postgres",
		User:     url.UserPassword(t.user, t.password),
		Host:     net.JoinHostPort(t.host, t.port),
		Path:     "/" + t.name,
		RawQuery: url.Values{"sslmode": []string{t.sslMode}}.Encode(),
	}).String()
}

// Address is the credential-free form, safe to print: the password never
// reaches the plan output, a log line or an error message.
func (t Target) Address() string {
	return fmt.Sprintf("postgres://%s@%s/%s?sslmode=%s", t.user, net.JoinHostPort(t.host, t.port), t.name, t.sslMode)
}

// --------------------------------------------------------------- session ---

// Session is the transaction surface the seeder needs. Keeping it an interface
// is what lets the whole write path be tested with no database at all: the
// tests substitute an in-memory recorder and assert on the exact statements.
//
// The variadic ...any is pgx's own parameter type, not a modelling choice, and
// every statement in this package binds only strings and *uuid.UUID.
type Session interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Release(ctx context.Context, commit bool) error
	Close()
}

// Dialer opens a Session. main.go takes one as a parameter so the command can
// be driven by a recorder instead of a socket.
type Dialer func(ctx context.Context, dsn string) (Session, error)

// Dial opens one pooled connection and starts a single transaction. One
// transaction for the whole plan means a rejected row leaves the database
// exactly as it was: a half-seeded database is never observable.
func Dial(ctx context.Context, dsn string) (Session, error) {
	ctx, cancel := context.WithTimeout(ctx, connectTimeout)
	defer cancel()

	// ParseConfig does not connect, so a malformed DSN is reported before any
	// socket is opened. The DSN carries the password, so it never appears in
	// the error message.
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parsing database configuration: %w", err)
	}
	cfg.MaxConns = 1
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("opening database connection: %w", err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		pool.Close()
		return nil, fmt.Errorf("opening seed transaction: %w", err)
	}
	return &pgxSession{pool: pool, tx: tx}, nil
}

// pgxSession is a pgx transaction plus the pool that owns its connection.
type pgxSession struct {
	pool *pgxpool.Pool
	tx   pgx.Tx
}

func (s *pgxSession) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	return s.tx.Exec(ctx, sql, args...)
}

func (s *pgxSession) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return s.tx.QueryRow(ctx, sql, args...)
}

// Release is the only exit from a transaction: commit the plan, or roll the
// whole thing back. There is no third option where a failure leaves rows
// behind.
func (s *pgxSession) Release(ctx context.Context, commit bool) error {
	if commit {
		return s.tx.Commit(ctx)
	}
	return s.tx.Rollback(ctx)
}

// Close returns the connection to the pool. pgxpool.Close reports nothing to
// check, but the connection must come back even when Apply fails, so this is
// the one place the session lifetime is bounded.
func (s *pgxSession) Close() { s.pool.Close() }

// ------------------------------------------------------------------ SQL ---

// Upserts, not inserts. role and users key on their natural unique key;
// location, purpose and vendor have none, so their row id is derived from a
// stable key (seeddata.DeriveID) and ON CONFLICT (id) is deterministic.
//
// is_active on location and purpose, is_blacklisted on vendor, and status and
// last_login_at on users are deliberately absent from every UPDATE: those are
// operator-controlled, and a re-run must not resurrect a deactivated account or
// wipe a suspension. updated_at does move, because the seed really did rewrite
// the row.
const (
	upsertRoleSQL = `
INSERT INTO role (name, permissions)
VALUES ($1, $2::jsonb)
ON CONFLICT (name) DO UPDATE SET permissions = EXCLUDED.permissions
RETURNING id`

	upsertLocationSQL = `
INSERT INTO location (id, name, type, address, city, timezone)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    type = EXCLUDED.type,
    address = EXCLUDED.address,
    city = EXCLUDED.city,
    timezone = EXCLUDED.timezone`

	upsertPurposeSQL = `
INSERT INTO purpose (id, name)
VALUES ($1, $2)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`

	upsertVendorSQL = `
INSERT INTO vendor (id, name)
VALUES ($1, $2)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`

	upsertUserSQL = `
INSERT INTO users (name, email, password_hash, role_id, location_id, type, status, vendor_id, nik, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
ON CONFLICT (email) DO UPDATE SET
    name = EXCLUDED.name,
    password_hash = EXCLUDED.password_hash,
    role_id = EXCLUDED.role_id,
    location_id = EXCLUDED.location_id,
    type = EXCLUDED.type,
    vendor_id = EXCLUDED.vendor_id,
    nik = EXCLUDED.nik,
    updated_at = now()`
)

// Apply writes the whole plan inside the caller's transaction. It re-validates
// first, so the guard the dry run exercised is the same guard the write path
// depends on.
//
// The order is dependency order, not reading order: a user row carries
// location_id and vendor_id as foreign keys, so the facilities and companies
// those keys point at have to exist first. Inserting users earlier aborts the
// whole transaction on users_location_id_fkey, which is why the order is
// asserted in store_test.go rather than left for a database to discover.
func Apply(ctx context.Context, db Session, p seeddata.SeedPlan, hashes map[string]string) error {
	if err := seeddata.Validate(p); err != nil {
		return fmt.Errorf("refusing to seed: %w", err)
	}
	roleIDs, err := applyRoles(ctx, db, p.Roles)
	if err != nil {
		return err
	}
	for _, l := range p.Locations {
		if _, err := db.Exec(ctx, upsertLocationSQL, seeddata.DeriveID(seeddata.EntityLocation, l.Code), l.Name, l.Type, l.Address, l.City, l.Timezone); err != nil {
			return fmt.Errorf("location %s: %w", l.Code, err)
		}
	}
	for _, pr := range p.Purposes {
		if _, err := db.Exec(ctx, upsertPurposeSQL, seeddata.DeriveID(seeddata.EntityPurpose, pr.Code), pr.Name); err != nil {
			return fmt.Errorf("purpose %s: %w", pr.Code, err)
		}
	}
	for _, v := range p.Vendors {
		if _, err := db.Exec(ctx, upsertVendorSQL, seeddata.DeriveID(seeddata.EntityVendor, v.Name), v.Name); err != nil {
			return fmt.Errorf("vendor %s: %w", v.Name, err)
		}
	}
	return applyUsers(ctx, db, p.Users, roleIDs, hashes)
}

// applyRoles returns the database ids of the four roles, which applyUsers needs
// for role_id. RETURNING id makes this one round trip per role and keeps the
// ids authoritative: the seeder never guesses a role uuid, and a role that
// already existed keeps its id, so visit history stays attached to it.
func applyRoles(ctx context.Context, db Session, roles []seeddata.SeedRole) (map[string]uuid.UUID, error) {
	ids := make(map[string]uuid.UUID, len(roles))
	for _, r := range roles {
		var id uuid.UUID
		if err := db.QueryRow(ctx, upsertRoleSQL, r.Name, r.Permissions).Scan(&id); err != nil {
			return nil, fmt.Errorf("role %s: %w", r.Name, err)
		}
		ids[r.Name] = id
	}
	return ids, nil
}

func applyUsers(ctx context.Context, db Session, users []seeddata.SeedUser, roleIDs map[string]uuid.UUID, hashes map[string]string) error {
	for _, u := range users {
		roleID, ok := roleIDs[u.Role]
		if !ok {
			return fmt.Errorf("user %s: role %q was not upserted", u.Email, u.Role)
		}
		hash, ok := hashes[u.Email]
		if !ok {
			return fmt.Errorf("user %s: no password hash was produced", u.Email)
		}
		locationID, err := resolveRef(u.Email, "location", u.LocationCode, seeddata.ResolveLocationID)
		if err != nil {
			return err
		}
		vendorID, err := resolveRef(u.Email, "vendor", u.VendorName, seeddata.ResolveVendorID)
		if err != nil {
			return err
		}
		// locationID and vendorID travel as *uuid.UUID so an unreferenced one
		// reaches pgx as SQL NULL, which is exactly what
		// enforce_user_location_invariant() demands of super_admin and vendor.
		// The NIK travels as *string for the same reason: an absent NIK
		// (security, super_admin) reaches pgx as SQL NULL rather than an
		// empty string chk_users_nik would reject.
		var nik *string
		if u.NIK != "" {
			value := u.NIK
			nik = &value
		}
		if _, err := db.Exec(ctx, upsertUserSQL, u.Name, u.Email, hash, roleID, locationID, u.Type, u.Status, vendorID, nik); err != nil {
			return fmt.Errorf("user %s: %w", u.Email, err)
		}
	}
	return nil
}

// resolveRef turns a plan reference into an id, keeping "not referenced" (a
// legitimate nil) distinct from "referenced something absent" (an error, never
// a silently NULL foreign key).
func resolveRef(email, kind, key string, resolve func(string) *uuid.UUID) (*uuid.UUID, error) {
	if key == "" {
		return nil, nil
	}
	id := resolve(key)
	if id == nil {
		return nil, fmt.Errorf("user %s: unknown %s %q", email, kind, key)
	}
	return id, nil
}
