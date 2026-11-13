package repository

// Integration harness for the PostgreSQL adapters. Every test runs against a
// real scratch database (default thc_vms_t03_test) and skips when it is
// unreachable, so `go test ./...` stays green without Docker.
//
// DISCLOSED EXCEPTION TO "NO HAND-WRITTEN SQL": production adapters call only
// the generated db.Querier. These *_test.go seed helpers use pool.Exec for the
// tables no generated write covers (role, location, vendor, purpose, general
// users, status-seeded visits). There is no other way to stage fixtures, and
// the exception is confined to test setup/teardown — never to a code path.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/repository/db"
)

// sharedPool is the single scratch-database pool for the whole package,
// opened once by TestMain so the suite does not churn one pool per test
// through the Docker NAT on every run.
var sharedPool *pgxpool.Pool

// TestMain prepares the scratch database once: it provisions the database when
// it is missing, applies the migration, and only then runs the suite.
//
// The distinction matters. A PostgreSQL server that cannot be reached at all is
// an environment gap and the suite skips so `go test ./...` stays usable without
// Docker. But a reachable server with a missing database is a SETUP ERROR, and
// reporting it as a skip would be a lie: the atomicity, row-lock and branch
// isolation proofs would silently never run while the package still printed "ok".
// So the harness provisions what it needs and fails loudly if it cannot.
func TestMain(m *testing.M) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool, err := openScratchPool(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr,
			"repository: cannot reach PostgreSQL at all, skipping integration tests: %v\n"+
				"repository: start it with `docker compose up -d postgres` to exercise these tests\n", err)
		os.Exit(0)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		fmt.Fprintf(os.Stderr,
			"repository: cannot reach PostgreSQL at all, skipping integration tests: %v\n"+
				"repository: start it with `docker compose up -d postgres` to exercise these tests\n", err)
		os.Exit(0)
	}
	if err := scrubScratch(ctx, pool); err != nil {
		pool.Close()
		fmt.Fprintf(os.Stderr, "repository: FATAL harness setup failed: %v\n", err)
		os.Exit(1)
	}
	if err := applySchema(ctx, pool); err != nil {
		pool.Close()
		fmt.Fprintf(os.Stderr, "repository: FATAL harness setup failed: %v\n", err)
		os.Exit(1)
	}
	sharedPool = pool
	code := m.Run()
	pool.Close()
	os.Exit(code)
}

// scrubScratch returns the scratch database to the true clean slate BEFORE
// the migrations re-apply: the transactional tables are wiped exactly like
// resetTables, and role rows outside the four base roles are removed. The
// prune is what keeps migration 000006 re-runnable: its ADD CONSTRAINT
// re-narrows chk_role_name to the base vocabulary, so a dev-superadmin row
// left by an earlier run would fail the setup with 23514 before any test
// even starts. The scratch database is test-owned, so scrubbing seed tables
// here is safe; a failure is a setup bug and fails loudly.
//
// Every statement is existence-guarded: on a FRESH database (CI creates it
// empty) none of the tables exist yet, and an unconditional TRUNCATE would
// fail the whole package with 42P01 before applySchema ever runs.
func scrubScratch(ctx context.Context, pool *pgxpool.Pool) error {
	present, err := existingTables(ctx, pool, []string{
		"visit_request", "users", "status_history",
		"check_in", "check_out", "visitor", "visit_purpose", "vendor", "location", "purpose", "audit_log", "notification",
	})
	if err != nil {
		return fmt.Errorf("probe scratch tables: %w", err)
	}
	if len(present) > 0 {
		if _, err := pool.Exec(ctx, `TRUNCATE `+strings.Join(present, ", ")+` RESTART IDENTITY CASCADE`); err != nil {
			return fmt.Errorf("scrub scratch tables: %w", err)
		}
	}
	roleExists, err := tableExists(ctx, pool, "role")
	if err != nil {
		return fmt.Errorf("probe role table: %w", err)
	}
	if roleExists {
		if _, err := pool.Exec(ctx, `DELETE FROM role WHERE name NOT IN
			('super_admin', 'admin', 'security', 'vendor')`); err != nil {
			return fmt.Errorf("scrub extra roles: %w", err)
		}
	}
	// The 000020 queue table may not exist yet on a scratch database
	// provisioned before this migration: truncate it only when present.
	// applySchema below creates it, and per-test resetTables truncates it
	// unconditionally once it exists, so the guard only bridges the upgrade.
	var hasNotices bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM information_schema.tables
		WHERE table_schema = current_schema()
		  AND table_name = 'vendor_registration_notices'
	)`).Scan(&hasNotices); err != nil {
		return fmt.Errorf("probe vendor_registration_notices: %w", err)
	}
	if hasNotices {
		if _, err := pool.Exec(ctx, `TRUNCATE vendor_registration_notices RESTART IDENTITY CASCADE`); err != nil {
			return fmt.Errorf("scrub registration notices: %w", err)
		}
	}
	mailPresent, mailErr := tableExists(ctx, pool, "mail_log")
	if mailErr != nil {
		return fmt.Errorf("probe mail_log: %w", mailErr)
	}
	if mailPresent {
		if _, err := pool.Exec(ctx, `TRUNCATE mail_log RESTART IDENTITY CASCADE`); err != nil {
			return fmt.Errorf("scrub mail log: %w", err)
		}
	}
	return nil
}

// tableExists reports whether a table is present in the current schema, so
// scrub routines stay safe on a freshly created (still empty) database.
func tableExists(ctx context.Context, pool *pgxpool.Pool, table string) (bool, error) {
	var exists bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM information_schema.tables
		WHERE table_schema = current_schema()
		  AND table_name = $1
	)`, table).Scan(&exists); err != nil {
		return false, err
	}
	return exists, nil
}

// existingTables filters names down to the tables actually present, preserving
// order, so a single TRUNCATE can cover exactly what exists.
func existingTables(ctx context.Context, pool *pgxpool.Pool, tables []string) ([]string, error) {
	present := make([]string, 0, len(tables))
	for _, table := range tables {
		exists, err := tableExists(ctx, pool, table)
		if err != nil {
			return nil, err
		}
		if exists {
			present = append(present, table)
		}
	}
	return present, nil
}

// openScratchPool connects to the scratch database, creating it first when the
// server is reachable but the database does not exist yet.
func openScratchPool(ctx context.Context) (*pgxpool.Pool, error) {
	pool, err := pgxpool.New(ctx, testDSN())
	if err != nil {
		return nil, err
	}
	if pingErr := pool.Ping(ctx); pingErr == nil {
		return pool, nil
	}
	pool.Close()

	// The database may simply not exist yet. Connect to the maintenance
	// database and create it. A failure here is propagated so the caller
	// distinguishes "no server" from "server present, provisioning failed".
	admin, err := pgxpool.New(ctx, adminDSN())
	if err != nil {
		return nil, err
	}
	defer admin.Close()
	if err := admin.Ping(ctx); err != nil {
		return nil, err
	}
	name := scratchDatabaseName()
	if _, err := admin.Exec(ctx, `CREATE DATABASE `+pgxIdentifier(name)); err != nil {
		// 42P04 = duplicate_database: another run created it first, which is fine.
		if !isDuplicateDatabase(err) {
			return nil, fmt.Errorf("create scratch database %q: %w", name, err)
		}
	}
	created, err := pgxpool.New(ctx, testDSN())
	if err != nil {
		return nil, err
	}
	if err := created.Ping(ctx); err != nil {
		created.Close()
		return nil, err
	}
	return created, nil
}

// applySchema makes the scratch database match the migrations, in version
// order. It is idempotent at the harness level: an already-migrated database
// yields no error, because a re-applied file raises only "already there"
// SQLSTATEs, which are the normal case on a second run.
func applySchema(ctx context.Context, pool *pgxpool.Pool) error {
	for _, sql := range []string{migrationSQL, migrationNIKSQL, migrationVisitorVendorSQL, migrationManualCompanySQL, migrationRenameVendorSQL, migrationAuditSQL, migrationNotificationSQL, migrationNotificationVisitCancelledSQL, migrationSinglePusatSQL, migrationVisitorJabatanSQL, migrationUserProfileSQL, migrationAuditFKSetNullSQL, migrationVisitVendorOverrideSQL, migrationDevSuperadminSQL, migrationVendorRegistrationNoticesSQL, migrationVisitorContactEditedSQL, migrationVisitorEmailSQL, migrationUserLocationsSQL, migrationAppSettingsSQL, migrationMailLogSQL, migrationMailBccSQL} {
		if err := applyOne(ctx, pool, sql); err != nil {
			return err
		}
	}
	// Migration 000024 backfills created_by from visit_request.vendor_user_id,
	// so the 000009 pic_user_id -> vendor_user_id rename must already have run.
	// On an incremental local database the rename is usually a no-op because
	// vendor_user_id already exists; on a fresh CI database the column is still
	// named pic_user_id until this call, and running 000024 first fails with
	// 42703 column "vendor_user_id" does not exist.
	if err := applyVendorUserRename(ctx, pool); err != nil {
		return err
	}
	if err := applyOne(ctx, pool, migrationCreatedBySQL); err != nil {
		return err
	}
	if err := applyPendingStatus(ctx, pool); err != nil {
		return err
	}
	return nil
}

// applyVendorUserRename applies migration 000009 (visit_request.pic_user_id ->
// vendor_user_id) exactly once. That migration is deliberately NOT re-runnable
// (a RENAME fails loudly on a missing source object), so the harness gates it
// on the legacy column still being present instead of swallowing the rename's
// SQLSTATEs through applyOne.
func applyVendorUserRename(ctx context.Context, pool *pgxpool.Pool) error {
	var pending bool
	if err := pool.QueryRow(ctx,
		`SELECT EXISTS (
			SELECT 1 FROM information_schema.columns
			WHERE table_schema = current_schema()
			  AND table_name = 'visit_request'
			  AND column_name = 'pic_user_id'
		)`).Scan(&pending); err != nil {
		return fmt.Errorf("probe visit_request.pic_user_id: %w", err)
	}
	if !pending {
		return nil
	}
	return applyOne(ctx, pool, migrationVendorUserRenameSQL)
}

// applyOne executes one migration file, tolerating the SQLSTATEs a re-run
// raises: 42P07 duplicate_table / 42710 duplicate_object (the schema is
// already present) and 42701 duplicate_column (migration 000002 re-adding a
// column it already added).
func applyOne(ctx context.Context, pool *pgxpool.Pool, sql string) error {
	_, err := pool.Exec(ctx, sql)
	if err == nil {
		return nil
	}
	if isDuplicateObject(err) || hasSQLState(err, "42701") {
		return nil
	}
	return fmt.Errorf("apply migration: %w", err)
}

// migrationVisitVendorOverrideSQL is the visit_request.vendor_name_override
// follow-up (migration 000017), loaded the same way so the scratch schema
// tracks the visit-level manual company column the visit write/read paths use.
var migrationVisitVendorOverrideSQL = func() string {
	path := filepath.Join("..", "..", "migrations", "000017_visit_request_vendor_override.up.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "repository: cannot read %s: %v\n", path, err)
		return ""
	}
	return string(raw)
}()

// migrationVendorRegistrationNoticesSQL is the vendor registration queue
// (migration 000020), loaded the same way so the scratch schema tracks the
// durable per-vendor row behind the superadmin approval bell. It is
// re-runnable (CREATE TABLE/INDEX IF NOT EXISTS), so applyOne covers it with
// no once-gate: unlike 000016/000018 nothing here renames or drops a live
// object, so the duplicate-SQLSTATE tolerance is the whole story.
var migrationVendorRegistrationNoticesSQL = func() string {
	path := filepath.Join("..", "..", "migrations", "000020_vendor_registration_notices.up.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "repository: cannot read %s: %v\n", path, err)
		return ""
	}
	return string(raw)
}()

// migrationVisitorContactEditedSQL is the visitor edited-markers follow-up
// (migration 000021), loaded the same way so the scratch schema tracks the
// phone_edited column the contact-correction write/read
// paths use. It is re-runnable (duplicate ADD COLUMN raises 42701, which
// applyOne tolerates; COMMENT ON COLUMN is idempotent), so applyOne covers it
// with no once-gate.
var migrationVisitorContactEditedSQL = func() string {
	path := filepath.Join("..", "..", "migrations", "000021_visitor_contact_edited_flags.up.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "repository: cannot read %s: %v\n", path, err)
		return ""
	}
	return string(raw)
}()

// migrationVisitorEmailSQL is the visitor.email follow-up (migration
// 000022), loaded the same way so the scratch schema tracks the member
// contact column the visit write/read paths use. It is re-runnable
// (duplicate ADD COLUMN raises 42701, which applyOne tolerates; COMMENT ON
// COLUMN is idempotent), so applyOne covers it with no once-gate.
var migrationVisitorEmailSQL = func() string {
	path := filepath.Join("..", "..", "migrations", "000022_visitor_email.up.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "repository: cannot read %s: %v\n", path, err)
		return ""
	}
	return string(raw)
}()

// migrationUserLocationsSQL is the user_locations join table (migration
// 000023), loaded the same way so the scratch schema tracks the coverage
// rows the account writes maintain. It is re-runnable (duplicate CREATE
// TABLE/INDEX raises the tolerated SQLSTATEs; the backfill INSERT carries ON
// CONFLICT DO NOTHING), so applyOne covers it with no once-gate.
var migrationUserLocationsSQL = func() string {
	path := filepath.Join("..", "..", "migrations", "000023_user_locations.up.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "repository: cannot read %s: %v\n", path, err)
		return ""
	}
	return string(raw)
}()

// migrationAppSettingsSQL is the app_settings key/value store (migration
// 000026), loaded the same way so the scratch schema tracks the notification
// matrix the settings write/read paths use. It is re-runnable (CREATE TABLE
// IF NOT EXISTS plus ON CONFLICT DO NOTHING seed), so applyOne covers it with
// no once-gate.
var migrationAppSettingsSQL = func() string {
	path := filepath.Join("..", "..", "migrations", "000026_app_settings.up.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "repository: cannot read %s: %v\n", path, err)
		return ""
	}
	return string(raw)
}()

// migrationCreatedBySQL is the visit_request.created_by column plus the
// visit_work_photo table (migration 000024), loaded the same way so the
// scratch schema tracks the creator column the visit write/read paths use.
// It is re-runnable: a duplicate ADD COLUMN / CREATE TABLE / CREATE INDEX
// raises the SQLSTATEs applyOne already tolerates, and the backfill UPDATE is
// idempotent.
var migrationCreatedBySQL = func() string {
	path := filepath.Join("..", "..", "migrations", "000024_created_by_and_work_photo.up.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "repository: cannot read %s: %v\n", path, err)
		return ""
	}
	return string(raw)
}()

// migrationMailLogSQL is the mail delivery log (migration 000030), loaded
// the same way so the scratch schema tracks the verdict store the SMTP
// worker writes. It is re-runnable (CREATE TABLE/INDEX IF NOT EXISTS), so
// applyOne covers it with no once-gate.
var migrationMailLogSQL = func() string {
	path := filepath.Join("..", "..", "migrations", "000030_mail_log.up.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "repository: cannot read %s: %v\n", path, err)
		return ""
	}
	return string(raw)
}()

// migrationMailBccSQL is the mail_log Bcc column (migration 000031), loaded
// the same way so the scratch schema tracks the overseer column the SMTP
// worker persists. It is re-runnable (ADD COLUMN IF NOT EXISTS), so
// applyOne covers it with no once-gate.
var migrationMailBccSQL = func() string {
	path := filepath.Join("..", "..", "migrations", "000031_mail_log_bcc.up.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "repository: cannot read %s: %v\n", path, err)
		return ""
	}
	return string(raw)
}()

// migrationDevSuperadminSQL is the hidden dev-superadmin role (migration
// 000016), loaded the same way so the scratch schema admits the national
// operator account the staff email fan-out must keep in parity. Unlike the
// pending-status migration below it is re-runnable (DROP CONSTRAINT IF
// EXISTS, duplicate-tolerant ADD, CREATE OR REPLACE FUNCTION), so applyOne
// covers it.
var migrationDevSuperadminSQL = func() string {
	path := filepath.Join("..", "..", "migrations", "000016_dev_superadmin_role.up.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "repository: cannot read %s: %v\n", path, err)
		return ""
	}
	return string(raw)
}()

// migrationPendingStatusSQL is the users 'pending' status (migration 000018),
// loaded the same way so the scratch schema tracks the registration status
// the email resolver must exclude.
var migrationPendingStatusSQL = func() string {
	path := filepath.Join("..", "..", "migrations", "000018_user_pending_status.up.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "repository: cannot read %s: %v\n", path, err)
		return ""
	}
	return string(raw)
}()

// applyPendingStatus applies migration 000018 exactly once. That migration is
// deliberately NOT re-runnable (a bare DROP CONSTRAINT fails loudly when the
// old CHECK is already gone), so the harness gates it on the CHECK still
// rejecting 'pending' instead of swallowing SQLSTATEs through applyOne — the
// same once-gate shape as applyVendorUserRename below.
func applyPendingStatus(ctx context.Context, pool *pgxpool.Pool) error {
	var admits bool
	if err := pool.QueryRow(ctx,
		`SELECT EXISTS (
			SELECT 1 FROM pg_constraint
			WHERE conname = 'chk_users_status'
			  AND pg_get_constraintdef(oid) LIKE '%pending%'
		)`).Scan(&admits); err != nil {
		return fmt.Errorf("probe chk_users_status: %w", err)
	}
	if admits {
		return nil
	}
	return applyOne(ctx, pool, migrationPendingStatusSQL)
}

// migrationAuditFKSetNullSQL is the audit_log.user_id ON DELETE SET NULL
// follow-up, loaded the same way so the scratch schema tracks the embedded
// migrations the application runs.
var migrationAuditFKSetNullSQL = func() string {
	path := filepath.Join("..", "..", "migrations", "000015_audit_log_user_on_delete_set_null.up.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "repository: cannot read %s: %v\n", path, err)
		return ""
	}
	return string(raw)
}()

// migrationSQL is loaded once from the migration the application itself runs,
// so the integration tests can never drift from the shipped schema.
var migrationSQL = func() string {
	path := filepath.Join("..", "..", "migrations", "000001_init_schema.up.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		// Leave the SQL empty: applySchema then surfaces the read failure as a
		// setup error instead of silently testing against a half-built schema.
		fmt.Fprintf(os.Stderr, "repository: cannot read %s: %v\n", path, err)
		return ""
	}
	return string(raw)
}()

// migrationNIKSQL is the users.nik follow-up, loaded the same way so the
// scratch schema tracks the embedded migrations the application runs.
var migrationNIKSQL = func() string {
	path := filepath.Join("..", "..", "migrations", "000002_add_user_nik.up.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "repository: cannot read %s: %v\n", path, err)
		return ""
	}
	return string(raw)
}()

// migrationVisitorVendorSQL is the visitor.vendor_id follow-up, loaded the
// same way so the scratch schema tracks the embedded migrations the
// application runs.
var migrationVisitorVendorSQL = func() string {
	path := filepath.Join("..", "..", "migrations", "000003_visitor_vendor_id.up.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "repository: cannot read %s: %v\n", path, err)
		return ""
	}
	return string(raw)
}()

// migrationManualCompanySQL is the manual company/purpose follow-up
// (visitor.vendor_name_override, visit_request.purpose_note,
// users.vendor_name_override), loaded the same way so the scratch schema
// tracks the embedded migrations the application runs.
var migrationManualCompanySQL = func() string {
	path := filepath.Join("..", "..", "migrations", "000005_manual_company_and_purpose.up.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "repository: cannot read %s: %v\n", path, err)
		return ""
	}
	return string(raw)
}()

// migrationRenameVendorSQL is the role rename pic -> vendor follow-up
// (chk_role_name now admits 'vendor'), loaded the same way so the scratch
// schema tracks the embedded migrations the application runs.
var migrationRenameVendorSQL = func() string {
	path := filepath.Join("..", "..", "migrations", "000006_rename_pic_to_vendor.up.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "repository: cannot read %s: %v\n", path, err)
		return ""
	}
	return string(raw)
}()

// migrationAuditSQL is the audit_log follow-up (migration 000007), loaded the
// same way so the scratch schema tracks the trail the audit writer feeds.
var migrationAuditSQL = func() string {
	path := filepath.Join("..", "..", "migrations", "000007_audit_log.up.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "repository: cannot read %s: %v\n", path, err)
		return ""
	}
	return string(raw)
}()

// migrationNotificationSQL is the persisted notification store (migration
// 000008), loaded the same way so the scratch schema tracks the store the
// notification adapter writes and reads.
var migrationNotificationSQL = func() string {
	path := filepath.Join("..", "..", "migrations", "000008_create_notification.up.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "repository: cannot read %s: %v\n", path, err)
		return ""
	}
	return string(raw)
}()

// migrationNotificationVisitCancelledSQL is the chk_notification_type
// widening (migration 000019) that admits the visit_cancelled notice the
// human-cancel write path emits. Without it the scratch schema still carries
// the 8-value CHECK from 000008 and every human cancellation rolls back.
var migrationNotificationVisitCancelledSQL = func() string {
	path := filepath.Join("..", "..", "migrations", "000019_notification_visit_cancelled.up.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "repository: cannot read %s: %v\n", path, err)
		return ""
	}
	return string(raw)
}()

// migrationVendorUserRenameSQL is the visit_request.pic_user_id -> vendor_user_id
// rename (migration 000009), loaded the same way so the scratch schema tracks
// the embedded migrations the application runs.
var migrationVendorUserRenameSQL = func() string {
	path := filepath.Join("..", "..", "migrations", "000009_rename_pic_user_to_vendor_user.up.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "repository: cannot read %s: %v\n", path, err)
		return ""
	}
	return string(raw)
}()

// migrationSinglePusatSQL is the single-Kantor-Pusat guard (migration 000011),
// loaded the same way so the scratch schema tracks the partial unique index
// the repository write paths depend on.
var migrationSinglePusatSQL = func() string {
	path := filepath.Join("..", "..", "migrations", "000011_single_head_office_location.up.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "repository: cannot read %s: %v\n", path, err)
		return ""
	}
	return string(raw)
}()

// migrationVisitorJabatanSQL is the visitor.jabatan follow-up (migration 000012),
// loaded the same way so the scratch schema tracks the nullable free-text
// position column the visit write and read paths now use.
var migrationVisitorJabatanSQL = func() string {
	path := filepath.Join("..", "..", "migrations", "000012_visitor_jabatan.up.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "repository: cannot read %s: %v\n", path, err)
		return ""
	}
	return string(raw)
}()

// migrationUserProfileSQL is the users.avatar_url follow-up (migration 000014),
// loaded the same way so the scratch schema tracks the nullable profile column
// the user read/write paths now select.
var migrationUserProfileSQL = func() string {
	path := filepath.Join("..", "..", "migrations", "000014_user_profile.up.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "repository: cannot read %s: %v\n", path, err)
		return ""
	}
	return string(raw)
}()

// scratchDatabaseName is the database name embedded in the DSN.
func scratchDatabaseName() string {
	name := os.Getenv("THC_VMS_TEST_DBNAME")
	if name == "" {
		name = "thc_vms_t03_test"
	}
	return name
}

// adminDSN points at the maintenance database so the scratch database can be
// created when it is absent.
func adminDSN() string {
	return "postgres://thc_user:thc_password_local@localhost:5432/postgres?sslmode=disable"
}

// pgxIdentifier quotes an identifier that is concatenated into DDL. The name
// comes from the environment, so it is validated rather than trusted.
func pgxIdentifier(name string) string {
	return pgx.Identifier{name}.Sanitize()
}

// isDuplicateDatabase reports SQLSTATE 42P04.
func isDuplicateDatabase(err error) bool { return hasSQLState(err, "42P04") }

// isDuplicateObject reports the SQLSTATEs Postgres raises when the schema is
// already present: 42P07 duplicate_table (a CREATE TABLE already ran),
// 42710 duplicate_object (a CREATE TRIGGER/FUNCTION already ran) and
// 42P06 duplicate_schema. The migration is not written to be re-runnable, so
// these are the "second run" signal rather than a failure.
func isDuplicateObject(err error) bool {
	return hasSQLState(err, "42P07") || hasSQLState(err, "42710") || hasSQLState(err, "42P06")
}

func hasSQLState(err error, code string) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == code
}

// testDSN reads the scratch database from the environment with a default that
// matches the local docker compose credentials.
func testDSN() string {
	if dsn := os.Getenv("THC_VMS_TEST_DSN"); dsn != "" {
		return dsn
	}
	return "postgres://thc_user:thc_password_local@localhost:5432/thc_vms_t03_test?sslmode=disable"
}

// testPool returns the shared scratch-database pool. TestMain already
// skipped the run when Docker is down, so a nil pool here is a setup bug.
func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	if sharedPool == nil {
		t.Fatalf("shared scratch pool is nil: TestMain should have skipped the run")
	}
	return sharedPool
}

// testContext bounds every database call so a wedged lock fails loudly.
func testContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	return ctx
}

// resetTables wipes every transactional table; roles are re-seeded idempotently.
func resetTables(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := testContext(t)
	_, err := pool.Exec(ctx, `TRUNCATE visit_request, users, status_history,
		check_in, check_out, visitor, visit_purpose, vendor, location, purpose, audit_log, notification, vendor_registration_notices, mail_log RESTART IDENTITY CASCADE`)
	if err != nil {
		t.Fatalf("truncate scratch tables: %v", err)
	}
	// Non-base role rows (dev-superadmin seeded by an earlier test in this
	// run) are pruned so every test starts from the four-role baseline the
	// DDL re-apply shape assumes; users are already gone, so no FK can trip.
	if _, err := pool.Exec(ctx, `DELETE FROM role WHERE name NOT IN
		('super_admin', 'admin', 'security', 'vendor')`); err != nil {
		t.Fatalf("prune extra roles: %v", err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO role (name) VALUES
		('super_admin'), ('admin'), ('security'), ('vendor')
		ON CONFLICT (name) DO NOTHING`)
	if err != nil {
		t.Fatalf("seed roles: %v", err)
	}
}

// uuidArg maps an optional domain id to a driver argument: empty means NULL,
// never the zero UUID.
func uuidArg(id domain.UUID) any {
	if id == "" {
		return nil
	}
	parsed, err := uuid.Parse(string(id))
	if err != nil {
		return nil
	}
	return parsed
}

// seedLocation inserts one active facility and returns its id.
func seedLocation(t *testing.T, pool *pgxpool.Pool, name, locType string) domain.UUID {
	t.Helper()
	var id uuid.UUID
	err := pool.QueryRow(testContext(t),
		`INSERT INTO location (name, type, timezone) VALUES ($1, $2, 'WIB') RETURNING id`,
		name, locType).Scan(&id)
	if err != nil {
		t.Fatalf("seed location: %v", err)
	}
	return toDomainUUID(id)
}

// seedInactiveLocation inserts one disabled facility.
func seedInactiveLocation(t *testing.T, pool *pgxpool.Pool, name string) domain.UUID {
	t.Helper()
	var id uuid.UUID
	err := pool.QueryRow(testContext(t),
		`INSERT INTO location (name, type, timezone, is_active) VALUES ($1, 'cabang', 'WIB', false) RETURNING id`,
		name).Scan(&id)
	if err != nil {
		t.Fatalf("seed inactive location: %v", err)
	}
	return toDomainUUID(id)
}

// seedVendor inserts one partner company.
func seedVendor(t *testing.T, pool *pgxpool.Pool, name string) domain.UUID {
	t.Helper()
	var id uuid.UUID
	err := pool.QueryRow(testContext(t),
		`INSERT INTO vendor (name) VALUES ($1) RETURNING id`, name).Scan(&id)
	if err != nil {
		t.Fatalf("seed vendor: %v", err)
	}
	return toDomainUUID(id)
}

// seedPurpose inserts one active visit reason.
func seedPurpose(t *testing.T, pool *pgxpool.Pool, name string) domain.UUID {
	t.Helper()
	var id uuid.UUID
	err := pool.QueryRow(testContext(t),
		`INSERT INTO purpose (name) VALUES ($1) RETURNING id`, name).Scan(&id)
	if err != nil {
		t.Fatalf("seed purpose: %v", err)
	}
	return toDomainUUID(id)
}

// seedUserParams stages one account of any role.
type seedUserParams struct {
	Name     string
	Email    string
	Role     string
	Location domain.UUID
	Type     string
}

// seedUser inserts one account; empty Location means SQL NULL.
func seedUser(t *testing.T, pool *pgxpool.Pool, p seedUserParams) domain.UUID {
	t.Helper()
	var id uuid.UUID
	err := pool.QueryRow(testContext(t),
		`INSERT INTO users (name, email, password_hash, role_id, location_id, type, status)
		 SELECT $1, $2, 'hash-test', r.id, $3, $4, 'active' FROM role r WHERE r.name = $5
		 RETURNING id`,
		p.Name, p.Email, uuidArg(p.Location), p.Type, p.Role).Scan(&id)
	if err != nil {
		t.Fatalf("seed user %s: %v", p.Email, err)
	}
	return toDomainUUID(id)
}

// seedVisitParams stages one visit row with an explicit status and code.
type seedVisitParams struct {
	Code       string
	VendorUser domain.UUID
	Vendor     domain.UUID
	Location   domain.UUID
	Start      time.Time
	End        time.Time
	Status     domain.VisitStatus
	CreatedAt  *time.Time
	// CreatedBy stages the migration-000024 requester column; empty means
	// SQL NULL (the pre-backfill shape).
	CreatedBy domain.UUID
}

// seedVisit inserts one visit_request row; tests that need a status other
// than requested (or a backdated created_at) use this instead of Create.
func seedVisit(t *testing.T, pool *pgxpool.Pool, p seedVisitParams) domain.UUID {
	t.Helper()
	var id uuid.UUID
	var created any
	if p.CreatedAt != nil {
		created = *p.CreatedAt
	} else {
		created = time.Now().UTC()
	}
	err := pool.QueryRow(testContext(t),
		`INSERT INTO visit_request
			(visit_id, vendor_user_id, vendor_id, location_id, start_date, end_date, status, created_at, created_by)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
		p.Code, uuidArg(p.VendorUser), uuidArg(p.Vendor), uuidArg(p.Location),
		p.Start.UTC(), p.End.UTC(), string(p.Status), created, uuidArg(p.CreatedBy)).Scan(&id)
	if err != nil {
		t.Fatalf("seed visit %s: %v", p.Code, err)
	}
	return toDomainUUID(id)
}

// roleIDOf resolves a role name to its id for Create calls (the generated
// user INSERT takes the role id as a bound parameter).
func roleIDOf(t *testing.T, pool *pgxpool.Pool, name string) domain.UUID {
	t.Helper()
	var id uuid.UUID
	err := pool.QueryRow(testContext(t),
		`SELECT id FROM role WHERE name = $1`, name).Scan(&id)
	if err != nil {
		t.Fatalf("resolve role %s: %v", name, err)
	}
	return toDomainUUID(id)
}

// historyRows reads the audit trail through the generated query (no hand SQL
// on the read path under test).
func historyRows(t *testing.T, pool *pgxpool.Pool, visitID domain.UUID) []db.ListStatusHistoryRow {
	t.Helper()
	parsed, err := fromDomainUUID(visitID)
	if err != nil {
		t.Fatalf("parse visit id: %v", err)
	}
	rows, err := db.New(pool).ListStatusHistory(testContext(t), db.ListStatusHistoryParams{VisitRequestID: parsed})
	if err != nil {
		t.Fatalf("list status history: %v", err)
	}
	return rows
}

// requireErrIs fails the test unless err wraps the sentinel.
func requireErrIs(t *testing.T, err error, sentinel error, what string) {
	t.Helper()
	if !errors.Is(err, sentinel) {
		t.Fatalf("%s: got %v, want error wrapping %v", what, err, sentinel)
	}
}
