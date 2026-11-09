package repository

// Read-path suite for VisitRepository.ListStatusHistory: the 50-row window,
// oldest-first ordering, actor display resolution, and the NULL (system) row.

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/repository/db"
)

// TestListStatusHistory_OldestFirstCappedWithResolvedActors seeds 52 history
// rows one minute apart (even index = acting admin, odd index = system with
// NULL changed_by) and proves the read serves exactly the 50 NEWEST rows in
// ascending order, with the human rows carrying the display name plus the
// Indonesian role label and the system rows carrying nil actor pointers.
func TestListStatusHistory_OldestFirstCappedWithResolvedActors(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	repos := NewVisitRepository(pool)

	loc := seedLocation(t, pool, "Cabang Riwayat", "cabang")
	vendor := seedUser(t, pool, seedUserParams{Name: "Vendor Riwayat", Email: "riwayat@vendor.test", Role: "vendor", Type: "external"})
	admin := seedUser(t, pool, seedUserParams{Name: "Siti Rahayu", Email: "siti.riwayat@thc.test", Role: "admin", Location: loc, Type: "internal"})

	start := time.Now().UTC().Add(24 * time.Hour).Truncate(time.Second)
	visitID := seedVisit(t, pool, seedVisitParams{
		Code: "VST-0000000150", VendorUser: vendor, Location: loc,
		Start: start, End: start.Add(4 * time.Hour), Status: domain.VisitStatusRequested,
	})

	parsed, err := fromDomainUUID(visitID)
	if err != nil {
		t.Fatalf("parse visit id: %v", err)
	}
	changedBy, err := pgNullUUID(admin)
	if err != nil {
		t.Fatalf("actor uuid: %v", err)
	}

	const total = 52
	base := time.Date(2026, time.October, 1, 8, 0, 0, 0, time.UTC)
	for i := 0; i < total; i++ {
		row := db.InsertStatusHistoryParams{
			VisitRequestID: parsed,
			Status:         string(domain.VisitStatusApproved),
			ChangedBy:      pgtype.UUID{},
			ChangedAt:      pgtype.Timestamptz{Time: base.Add(time.Duration(i) * time.Minute), Valid: true},
		}
		if i%2 == 0 {
			row.ChangedBy = changedBy
		}
		if _, err := db.New(pool).InsertStatusHistory(ctx, row); err != nil {
			t.Fatalf("seed history row %d: %v", i, err)
		}
	}

	events, err := repos.ListStatusHistory(ctx, visitID)
	if err != nil {
		t.Fatalf("ListStatusHistory: %v", err)
	}
	if len(events) != 50 {
		t.Fatalf("events = %d, want the 50 newest of %d", len(events), total)
	}
	// The window keeps rows 2..51 of the seeded sequence, oldest first.
	if !events[0].At.Equal(base.Add(2 * time.Minute)) {
		t.Errorf("oldest event = %v, want %v (rows 0-1 dropped by the cap)", events[0].At, base.Add(2*time.Minute))
	}
	if !events[len(events)-1].At.Equal(base.Add((total - 1) * time.Minute)) {
		t.Errorf("newest event = %v, want %v", events[len(events)-1].At, base.Add((total-1)*time.Minute))
	}
	for i := 1; i < len(events); i++ {
		if events[i-1].At.After(events[i].At) {
			t.Fatalf("events not ascending at %d: %v after %v", i, events[i-1].At, events[i].At)
		}
	}

	// Seed index 2 (even) is the first human row inside the window; index 3
	// (odd) is the first system row.
	human := events[0]
	if human.ActorName == nil || *human.ActorName != "Siti Rahayu" {
		t.Errorf("human ActorName = %v, want Siti Rahayu", human.ActorName)
	}
	if human.ActorRoleLabel == nil || *human.ActorRoleLabel != "Admin Cabang" {
		t.Errorf("human ActorRoleLabel = %v, want Admin Cabang", human.ActorRoleLabel)
	}
	system := events[1]
	if system.ActorName != nil || system.ActorRoleLabel != nil {
		t.Errorf("system row must carry nil actors, got name=%v role=%v", system.ActorName, system.ActorRoleLabel)
	}
}
