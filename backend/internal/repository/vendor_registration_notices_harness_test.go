package repository

// Red-first foundation proof for migration 000020
// (vendor_registration_notices). Fails on a schema without the migration
// wired into the harness; passes once migrationVendorRegistrationNoticesSQL
// is applied in version order. Later waves build the sqlc adapter, the
// superadmin-only usecase fan-out and the frontend bell entry on top of the
// table shape pinned here.

import (
	"testing"

	"github.com/google/uuid"
)

// TestHarnessVendorRegistrationNoticesSchema pins the 000020 contract: the table
// exists with its five columns, vendor_user_id is unique (the
// ON CONFLICT DO NOTHING idempotency anchor), and the pending partial index
// keeps the approval-bell count cheap.
func TestHarnessVendorRegistrationNoticesSchema(t *testing.T) {
	pool := testPool(t)
	ctx := testContext(t)

	var tableExists bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM information_schema.tables
		WHERE table_schema = current_schema()
		  AND table_name = 'vendor_registration_notices'
	)`).Scan(&tableExists); err != nil {
		t.Fatalf("probe vendor_registration_notices: %v", err)
	}
	if !tableExists {
		t.Fatalf("table vendor_registration_notices missing: wire migration 000020 into applySchema")
	}

	cols := map[string]bool{}
	rows, err := pool.Query(ctx, `SELECT column_name FROM information_schema.columns
		WHERE table_schema = current_schema()
		  AND table_name = 'vendor_registration_notices'`)
	if err != nil {
		t.Fatalf("list vendor_registration_notices columns: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatalf("scan column name: %v", err)
		}
		cols[name] = true
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate columns: %v", err)
	}
	for _, want := range []string{"id", "vendor_user_id", "status", "resolved_at", "created_at"} {
		if !cols[want] {
			t.Fatalf("column vendor_registration_notices.%s missing", want)
		}
	}

	var partialIndex bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM pg_indexes
		WHERE schemaname = current_schema()
		  AND tablename = 'vendor_registration_notices'
		  AND indexname = 'idx_vendor_registration_notices_pending'
		  AND indexdef LIKE '%WHERE%pending%'
	)`).Scan(&partialIndex); err != nil {
		t.Fatalf("probe pending partial index: %v", err)
	}
	if !partialIndex {
		t.Fatalf("partial index idx_vendor_registration_notices_pending WHERE status='pending' missing")
	}

	// UNIQUE(vendor_user_id) is the idempotency anchor: the second insert
	// for the same vendor must collide, and ON CONFLICT DO NOTHING must
	// swallow the retry without touching the first row.
	resetTables(t, pool)
	vendorID := seedUser(t, pool, seedUserParams{
		Name: "Vendor Antre", Email: "antre-" + uuid.NewString() + "@example.com", Role: "vendor",
		Type: "external",
	})
	var first uuid.UUID
	if err := pool.QueryRow(ctx, `INSERT INTO vendor_registration_notices (vendor_user_id)
		VALUES ($1) RETURNING id`, vendorID).Scan(&first); err != nil {
		t.Fatalf("insert registration notice: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO vendor_registration_notices (vendor_user_id)
		VALUES ($1)`, vendorID); err == nil {
		t.Fatalf("duplicate vendor_user_id insert must collide on the UNIQUE anchor")
	}
	tag, err := pool.Exec(ctx, `INSERT INTO vendor_registration_notices (vendor_user_id)
		VALUES ($1) ON CONFLICT (vendor_user_id) DO NOTHING`, vendorID)
	if err != nil {
		t.Fatalf("idempotent re-insert: %v", err)
	}
	if tag.RowsAffected() != 0 {
		t.Fatalf("ON CONFLICT DO NOTHING must affect 0 rows, affected %d", tag.RowsAffected())
	}
	var status string
	if err := pool.QueryRow(ctx, `SELECT status FROM vendor_registration_notices
		WHERE vendor_user_id = $1`, vendorID).Scan(&status); err != nil {
		t.Fatalf("read notice status: %v", err)
	}
	if status != "pending" {
		t.Fatalf("status = %q, want pending default", status)
	}
}
