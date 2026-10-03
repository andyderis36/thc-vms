package repository

// Scope suite: branch isolation is total — a location filter can only reach
// the hard location_id equality, a vendor filter only its own rows, and the
// unscoped query runs only when both filters are nil.

import (
	"testing"
	"time"

	"github.com/google/uuid"

	"thc-vms/backend/internal/domain"
)

// Branch fixtures below stage two branches with visits owned by two different
// vendors; each scope test asserts its own view of the same shape.

// TestList_LocationScopeNeverLeaksOtherBranches seeds two branches and proves
// the location list contains only its own branch with a matching total.
func TestList_LocationScopeNeverLeaksOtherBranches(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	repos := NewVisitRepository(pool)

	locA := seedLocation(t, pool, "Cabang A Isolasi", "cabang")
	locB := seedLocation(t, pool, "Cabang B Isolasi", "pop")
	vendorA := seedUser(t, pool, seedUserParams{Name: "Vendor A", Email: "a@vendor.test", Role: "vendor", Type: "external"})
	vendorB := seedUser(t, pool, seedUserParams{Name: "Vendor B", Email: "b@vendor.test", Role: "vendor", Type: "external"})

	start := time.Now().UTC().Add(24 * time.Hour).Truncate(time.Second)
	end := start.Add(4 * time.Hour)
	seedVisit(t, pool, seedVisitParams{Code: "VST-0000000201", PIC: vendorA, Location: locA, Start: start, End: end, Status: domain.VisitStatusRequested})
	seedVisit(t, pool, seedVisitParams{Code: "VST-0000000202", PIC: vendorA, Location: locA, Start: start, End: end, Status: domain.VisitStatusApproved})
	seedVisit(t, pool, seedVisitParams{Code: "VST-0000000203", PIC: vendorB, Location: locB, Start: start, End: end, Status: domain.VisitStatusRequested})

	visits, total, err := repos.List(ctx, domain.VisitFilter{LocationID: &locA, Page: 1, Limit: 10})
	if err != nil {
		t.Fatalf("List location scope: %v", err)
	}
	if total != 2 {
		t.Fatalf("total = %d, want 2 (RED: envelope drifted from the page)", total)
	}
	if len(visits) != 2 {
		t.Fatalf("items = %d, want 2", len(visits))
	}
	for _, v := range visits {
		if v.LocationID != locA {
			t.Fatalf("leaked visit %s from branch %s into branch %s (RED: cross-branch leak)", v.VisitID, v.LocationID, locA)
		}
	}
}

// TestList_VendorScopeNeverLeaksOtherVendors proves a vendor sees only its own
// requests even when other vendors hold visits on the same branch.
func TestList_VendorScopeNeverLeaksOtherVendors(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	repos := NewVisitRepository(pool)

	loc := seedLocation(t, pool, "Cabang Vendor", "cabang")
	vendor1 := seedUser(t, pool, seedUserParams{Name: "Vendor Satu", Email: "satu@vendor.test", Role: "vendor", Type: "external"})
	vendor2 := seedUser(t, pool, seedUserParams{Name: "Vendor Dua", Email: "dua@vendor.test", Role: "vendor", Type: "external"})

	start := time.Now().UTC().Add(24 * time.Hour).Truncate(time.Second)
	end := start.Add(4 * time.Hour)
	seedVisit(t, pool, seedVisitParams{Code: "VST-0000000211", PIC: vendor1, Location: loc, Start: start, End: end, Status: domain.VisitStatusRequested})
	seedVisit(t, pool, seedVisitParams{Code: "VST-0000000212", PIC: vendor1, Location: loc, Start: start, End: end, Status: domain.VisitStatusApproved})
	seedVisit(t, pool, seedVisitParams{Code: "VST-0000000213", PIC: vendor2, Location: loc, Start: start, End: end, Status: domain.VisitStatusRequested})

	visits, total, err := repos.List(ctx, domain.VisitFilter{PICUserID: &vendor1, Page: 1, Limit: 10})
	if err != nil {
		t.Fatalf("List vendor scope: %v", err)
	}
	if total != 2 || len(visits) != 2 {
		t.Fatalf("total=%d items=%d, want 2 and 2", total, len(visits))
	}
	for _, v := range visits {
		if v.PICUserID != vendor1 {
			t.Fatalf("leaked visit %s of vendor %s into vendor %s (RED: cross-vendor leak)", v.VisitID, v.PICUserID, vendor1)
		}
	}
}

// TestList_NilScopeReturnsAllForSuperAdmin proves the unscoped query —
// reachable ONLY with both filters nil — returns every branch.
func TestList_NilScopeReturnsAllForSuperAdmin(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	repos := NewVisitRepository(pool)

	locA := seedLocation(t, pool, "Cabang All A", "cabang")
	locB := seedLocation(t, pool, "Cabang All B", "minipop")
	vendor := seedUser(t, pool, seedUserParams{Name: "Vendor All", Email: "all@vendor.test", Role: "vendor", Type: "external"})

	start := time.Now().UTC().Add(24 * time.Hour).Truncate(time.Second)
	end := start.Add(4 * time.Hour)
	seedVisit(t, pool, seedVisitParams{Code: "VST-0000000221", PIC: vendor, Location: locA, Start: start, End: end, Status: domain.VisitStatusRequested})
	seedVisit(t, pool, seedVisitParams{Code: "VST-0000000222", PIC: vendor, Location: locB, Start: start, End: end, Status: domain.VisitStatusApproved})
	seedVisit(t, pool, seedVisitParams{Code: "VST-0000000223", PIC: vendor, Location: locB, Start: start, End: end, Status: domain.VisitStatusRejected})

	visits, total, err := repos.List(ctx, domain.VisitFilter{Page: 1, Limit: 10})
	if err != nil {
		t.Fatalf("List super_admin scope: %v", err)
	}
	if total != 3 || len(visits) != 3 {
		t.Fatalf("total=%d items=%d, want 3 and 3 (RED: super_admin missed a branch)", total, len(visits))
	}
}

// TestFindByVisitCode_ResolvesManualScanCode proves the SCR-05 manual fallback:
// a printed code resolves, and a bogus code reports ErrNotFound.
func TestFindByVisitCode_ResolvesManualScanCode(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	repos := NewVisitRepository(pool)

	loc := seedLocation(t, pool, "Cabang Pindai", "cabang")
	vendor := seedUser(t, pool, seedUserParams{Name: "Vendor Pindai", Email: "pindai@vendor.test", Role: "vendor", Type: "external"})

	start := time.Now().UTC().Add(24 * time.Hour).Truncate(time.Second)
	id := seedVisit(t, pool, seedVisitParams{
		Code: "VST-0000000231", PIC: vendor, Location: loc,
		Start: start, End: start.Add(4 * time.Hour), Status: domain.VisitStatusApproved,
	})

	got, err := repos.FindByVisitCode(ctx, "VST-0000000231")
	if err != nil {
		t.Fatalf("FindByVisitCode: %v", err)
	}
	if got.ID != id {
		t.Fatalf("resolved id = %s, want %s", got.ID, id)
	}
	if _, err := repos.FindByVisitCode(ctx, "VST-9999999999"); err == nil {
		t.Fatalf("bogus code resolved, want ErrNotFound")
	} else {
		requireErrIs(t, err, domain.ErrNotFound, "bogus visit code")
	}
}

// TestFindByID_MissingReturnsNotFound proves unknown ids surface ErrNotFound
// on both the visit and the user read.
func TestFindByID_MissingReturnsNotFound(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)

	missing := domain.UUID(uuid.NewString())
	if _, err := NewVisitRepository(pool).FindByID(ctx, missing); err == nil {
		t.Fatalf("visit FindByID on missing id succeeded, want ErrNotFound")
	} else {
		requireErrIs(t, err, domain.ErrNotFound, "missing visit")
	}
	if _, err := NewUserRepository(pool).FindByID(ctx, missing); err == nil {
		t.Fatalf("user FindByID on missing id succeeded, want ErrNotFound")
	} else {
		requireErrIs(t, err, domain.ErrNotFound, "missing user")
	}
}
