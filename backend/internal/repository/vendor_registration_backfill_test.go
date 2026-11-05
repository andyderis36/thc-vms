package repository

import (
	"testing"

	"github.com/google/uuid"
)

// TestBackfillVendorRegistrationNoticesIdempotent seeds 3 pending vendors
// plus 1 active vendor, runs the backfill twice, and pins the core
// acceptance: the first run inserts exactly 3 rows, the second inserts 0.
func TestBackfillVendorRegistrationNoticesIdempotent(t *testing.T) {
	pool := testPool(t)
	ctx := testContext(t)
	resetTables(t, pool)

	pending := make([]string, 0, 3)
	for i := 0; i < 3; i++ {
		pending = append(pending, string(seedUser(t, pool, seedUserParams{
			Name: "Pending Vendor", Email: "pending-" + uuid.NewString() + "@example.com",
			Role: "vendor", Type: "external",
		})))
	}
	seedUser(t, pool, seedUserParams{
		Name: "Active Vendor", Email: "active-" + uuid.NewString() + "@example.com",
		Role: "vendor", Type: "external",
	})

	if _, err := pool.Exec(ctx, `UPDATE users SET status = 'pending' WHERE id::text = ANY($1)`,
		pending); err != nil {
		t.Fatalf("stage pending vendors: %v", err)
	}

	first, err := BackfillVendorRegistrationNotices(ctx, pool)
	if err != nil {
		t.Fatalf("first backfill run: %v", err)
	}
	if first != 3 {
		t.Fatalf("first run inserted %d rows, want 3", first)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM vendor_registration_notices`).Scan(&count); err != nil {
		t.Fatalf("count notices: %v", err)
	}
	if count != 3 {
		t.Fatalf("notices rows = %d, want 3", count)
	}

	second, err := BackfillVendorRegistrationNotices(ctx, pool)
	if err != nil {
		t.Fatalf("second backfill run: %v", err)
	}
	if second != 0 {
		t.Fatalf("second run inserted %d rows, want 0 (idempotent no-op)", second)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM vendor_registration_notices`).Scan(&count); err != nil {
		t.Fatalf("recount notices: %v", err)
	}
	if count != 3 {
		t.Fatalf("notices rows after rerun = %d, want 3", count)
	}
}
