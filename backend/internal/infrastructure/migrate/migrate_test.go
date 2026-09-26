package migrate_test

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"thc-vms/backend/internal/infrastructure/migrate"
)

// scratchDSN points at the T11 database this package owns. Other packages own
// thc_vms_t03_test; this one must never touch it or thc_vms_db.
func scratchDSN() string {
	if dsn := os.Getenv("THC_VMS_T11_DSN"); dsn != "" {
		return dsn
	}
	return "postgres://thc_user:thc_password_local@localhost:5432/thc_vms_t11_test?sslmode=disable"
}

const adminDSN = "postgres://thc_user:thc_password_local@localhost:5432/postgres?sslmode=disable"

// ensureScratch provisions thc_vms_t11_test when the server is reachable and
// skips the test with a clear reason when it is not.
func ensureScratch(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	probe, err := pgx.Connect(ctx, scratchDSN())
	if err == nil {
		_ = probe.Close(ctx)
		return
	}
	admin, err := pgx.Connect(ctx, adminDSN)
	if err != nil {
		t.Skipf("postgres unreachable, skipping migrate test: %v", err)
	}
	defer func() { _ = admin.Close(ctx) }()
	if _, err := admin.Exec(ctx, `CREATE DATABASE thc_vms_t11_test`); err != nil {
		_ = admin.Close(ctx)
		t.Skipf("cannot provision thc_vms_t11_test, skipping: %v", err)
	}
	_ = admin.Close(ctx)
}

// dropScratch removes the database this test created so repeated runs start
// clean. It never touches any other database.
func dropScratch(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	admin, err := pgx.Connect(ctx, adminDSN)
	if err != nil {
		t.Logf("cannot reach postgres to drop scratch db: %v", err)
		return
	}
	defer func() { _ = admin.Close(ctx) }()
	if _, err := admin.Exec(ctx, `DROP DATABASE IF EXISTS thc_vms_t11_test WITH (FORCE)`); err != nil {
		t.Logf("cannot drop scratch db: %v", err)
	}
}

// TestMigrate_UpIsIdempotent applies the embedded migration twice against the
// scratch database this package owns: the second call must be a clean no-op
// and the tables must exist.
func TestMigrate_UpIsIdempotent(t *testing.T) {
	ensureScratch(t)
	t.Cleanup(func() { dropScratch(t) })
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if err := migrate.Up(ctx, scratchDSN()); err != nil {
		t.Fatalf("first Up: %v", err)
	}
	if err := migrate.Up(ctx, scratchDSN()); err != nil {
		t.Fatalf("second Up is not a clean no-op: %v", err)
	}
	conn, err := pgx.Connect(ctx, scratchDSN())
	if err != nil {
		t.Fatalf("connect to scratch db: %v", err)
	}
	defer func() { _ = conn.Close(ctx) }()
	for _, table := range []string{"role", "users", "location", "visit_request", "check_in", "check_out"} {
		var exists bool
		query := `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1)`
		if err := conn.QueryRow(ctx, query, table).Scan(&exists); err != nil {
			t.Fatalf("probe table %s: %v", table, err)
		}
		if !exists {
			t.Errorf("table %s does not exist after migrate.Up", table)
		}
	}
	fmt.Fprintln(os.Stderr, "migrate test scratch database: thc_vms_t11_test")
}
