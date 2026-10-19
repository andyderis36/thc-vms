package repository

// Round-trip suite: writes persist visit_purpose rows and reads must attach
// the purpose catalogue (id + name) on single-GET and on every list page,
// with one batched query per page instead of N+1.

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"thc-vms/backend/internal/domain"
)

// linkPurpose inserts one visit_purpose join row directly: seedVisit stages
// the parent visit row only, so tests needing links add them here.
func linkPurpose(t *testing.T, pool *pgxpool.Pool, visitID, purposeID domain.UUID) {
	t.Helper()
	if _, err := pool.Exec(testContext(t),
		`INSERT INTO visit_purpose (visit_request_id, purpose_id) VALUES ($1, $2)`,
		uuidArg(visitID), uuidArg(purposeID)); err != nil {
		t.Fatalf("link purpose: %v", err)
	}
}

// TestFindByID_AttachesPurposes proves the create-then-read round trip: the
// purpose links written by Create come back on the single-GET with id + name.
func TestFindByID_AttachesPurposes(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	repos := NewVisitRepository(pool)

	loc := seedLocation(t, pool, "Cabang Tujuan", "cabang")
	vendor := seedUser(t, pool, seedUserParams{Name: "Vendor Tujuan", Email: "tujuan@vendor.test", Role: "vendor", Type: "external"})
	maint := seedPurpose(t, pool, "Maintenance Genset")
	trouble := seedPurpose(t, pool, "Troubleshoot FO")

	start := time.Now().UTC().Add(24 * time.Hour).Truncate(time.Second)
	created, err := repos.Create(ctx, domain.VisitRequest{
		VendorUserID:  vendor,
		LocationID:    loc,
		StartDate:     start,
		EndDate:       start.Add(4 * time.Hour),
		IsNDAAccepted: true,
	}, []domain.Visitor{{Name: "Teknisi Tujuan", IDNumber: "ID-1", Phone: "0811"}},
		[]domain.UUID{trouble, maint})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	got, err := repos.FindByID(ctx, created.ID)
	if err != nil {
		t.Fatalf("FindByID: %v", err)
	}
	if got.Purposes == nil {
		t.Fatalf("Purposes is nil, want non-nil slice so the wire renders [] instead of null")
	}
	if len(got.Purposes) != 2 {
		t.Fatalf("purposes = %d, want 2", len(got.Purposes))
	}
	// The sqlc query orders by purpose name, so Maintenance sorts first.
	if got.Purposes[0].Name != "Maintenance Genset" || got.Purposes[1].Name != "Troubleshoot FO" {
		t.Fatalf("purposes = [%q %q], want [Maintenance Genset Troubleshoot FO]",
			got.Purposes[0].Name, got.Purposes[1].Name)
	}
	if got.Purposes[0].ID != maint || got.Purposes[1].ID != trouble {
		t.Fatalf("purpose ids = [%s %s], want [%s %s]",
			got.Purposes[0].ID, got.Purposes[1].ID, maint, trouble)
	}
	if len(got.Visitors) != 1 {
		t.Fatalf("visitors = %d, want 1 (purposes must not disturb the roster)", len(got.Visitors))
	}

	// The scanner manual fallback carries the same catalogue.
	byCode, err := repos.FindByVisitCode(ctx, created.VisitID)
	if err != nil {
		t.Fatalf("FindByVisitCode: %v", err)
	}
	if len(byCode.Purposes) != 2 {
		t.Fatalf("FindByVisitCode purposes = %d, want 2", len(byCode.Purposes))
	}
}

// TestList_AttachesPurposesPerPage proves the paged list batches the purpose
// catalogue: a visit with links renders them, a visit without links renders a
// non-nil empty slice instead of null.
func TestList_AttachesPurposesPerPage(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	repos := NewVisitRepository(pool)

	loc := seedLocation(t, pool, "Cabang Daftar", "cabang")
	vendor := seedUser(t, pool, seedUserParams{Name: "Vendor Daftar", Email: "daftar@vendor.test", Role: "vendor", Type: "external"})
	purpose := seedPurpose(t, pool, "Survey Lokasi")

	start := time.Now().UTC().Add(24 * time.Hour).Truncate(time.Second)
	end := start.Add(4 * time.Hour)
	withPurpose := seedVisit(t, pool, seedVisitParams{
		Code: "VST-0000000241", VendorUser: vendor, Location: loc,
		Start: start, End: end, Status: domain.VisitStatusRequested,
	})
	withoutPurpose := seedVisit(t, pool, seedVisitParams{
		Code: "VST-0000000242", VendorUser: vendor, Location: loc,
		Start: start, End: end, Status: domain.VisitStatusRequested,
	})
	linkPurpose(t, pool, withPurpose, purpose)

	visits, total, err := repos.List(ctx, domain.VisitFilter{LocationID: &loc, Page: 1, Limit: 10})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if total != 2 || len(visits) != 2 {
		t.Fatalf("total=%d items=%d, want 2 and 2", total, len(visits))
	}
	byID := make(map[domain.UUID]domain.VisitRequest, len(visits))
	for _, v := range visits {
		byID[v.ID] = v
	}
	withP := byID[withPurpose]
	if len(withP.Purposes) != 1 || withP.Purposes[0].ID != purpose || withP.Purposes[0].Name != "Survey Lokasi" {
		t.Fatalf("visit with purpose renders %+v, want [{Survey Lokasi}]", withP.Purposes)
	}
	withoutP := byID[withoutPurpose]
	if withoutP.Purposes == nil {
		t.Fatalf("visit without purpose has nil Purposes, want non-nil [] so the wire renders []")
	}
	if len(withoutP.Purposes) != 0 {
		t.Fatalf("visit without purpose renders %d purposes, want 0", len(withoutP.Purposes))
	}
}
