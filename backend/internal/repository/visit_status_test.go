package repository

// Atomicity suite for VisitRepository.UpdateStatus / Reschedule: one status
// write plus exactly one history row in one transaction, or nothing at all.

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"thc-vms/backend/internal/domain"
)

// TestUpdateStatus_WritesHistoryAtomically proves the PRD L129 contract both
// ways: the happy path leaves status + one history row, and a failure inside
// the transaction (here a changed_by FK violation from an unknown actor)
// leaves BOTH tables unchanged.
func TestUpdateStatus_WritesHistoryAtomically(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	repos := NewVisitRepository(pool)

	loc := seedLocation(t, pool, "Cabang Atomik", "cabang")
	vendor := seedUser(t, pool, seedUserParams{Name: "Vendor Atom", Email: "atom@vendor.test", Role: "vendor", Type: "external"})
	admin := seedUser(t, pool, seedUserParams{Name: "Admin Atom", Email: "admin.atom@thc.test", Role: "admin", Location: loc, Type: "internal"})

	start := time.Now().UTC().Add(24 * time.Hour).Truncate(time.Second)
	end := start.Add(4 * time.Hour)
	visitID := seedVisit(t, pool, seedVisitParams{
		Code: "VST-0000000101", PIC: vendor, Location: loc,
		Start: start, End: end, Status: domain.VisitStatusRequested,
	})

	if err := repos.UpdateStatus(ctx, visitID, domain.VisitStatusApproved, admin, "disetujui"); err != nil {
		t.Fatalf("UpdateStatus: %v", err)
	}
	got, err := repos.FindByID(ctx, visitID)
	if err != nil {
		t.Fatalf("FindByID: %v", err)
	}
	if got.Status != domain.VisitStatusApproved {
		t.Fatalf("status = %s, want approved", got.Status)
	}
	rows := historyRows(t, pool, visitID)
	if len(rows) != 1 {
		t.Fatalf("history rows = %d, want exactly 1", len(rows))
	}
	if rows[0].Status != string(domain.VisitStatusApproved) {
		t.Fatalf("history status = %s, want approved", rows[0].Status)
	}
	if !rows[0].ChangedBy.Valid {
		t.Fatalf("history changed_by is NULL, want the approving admin")
	}

	// Forced failure: a well-formed but unknown actor violates the
	// status_history.changed_by foreign key AFTER the status write, so the
	// rollback must undo both.
	ghost := domain.UUID(uuid.NewString())
	err = repos.UpdateStatus(ctx, visitID, domain.VisitStatusRejected, ghost, "ditolak hantu")
	if err == nil {
		t.Fatalf("UpdateStatus with unknown actor succeeded, want FK failure")
	}
	got, err = repos.FindByID(ctx, visitID)
	if err != nil {
		t.Fatalf("FindByID after rollback: %v", err)
	}
	if got.Status != domain.VisitStatusApproved {
		t.Fatalf("status after rollback = %s, want approved (unchanged)", got.Status)
	}
	if rows := historyRows(t, pool, visitID); len(rows) != 1 {
		t.Fatalf("history rows after rollback = %d, want 1 (unchanged)", len(rows))
	}
}

// TestUpdateStatus_ConcurrentApproveOnlyOneWins serialises two simultaneous
// approvals on the row lock: exactly one succeeds and exactly one history row
// exists afterwards.
func TestUpdateStatus_ConcurrentApproveOnlyOneWins(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	repos := NewVisitRepository(pool)

	loc := seedLocation(t, pool, "Cabang Balap", "cabang")
	vendor := seedUser(t, pool, seedUserParams{Name: "Vendor Balap", Email: "balap@vendor.test", Role: "vendor", Type: "external"})
	admin := seedUser(t, pool, seedUserParams{Name: "Admin Balap", Email: "admin.balap@thc.test", Role: "admin", Location: loc, Type: "internal"})

	start := time.Now().UTC().Add(24 * time.Hour).Truncate(time.Second)
	visitID := seedVisit(t, pool, seedVisitParams{
		Code: "VST-0000000102", PIC: vendor, Location: loc,
		Start: start, End: start.Add(4 * time.Hour), Status: domain.VisitStatusRequested,
	})

	var wg sync.WaitGroup
	gun := make(chan struct{})
	errs := make([]error, 2)
	for i := range errs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-gun
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			errs[i] = repos.UpdateStatus(ctx, visitID, domain.VisitStatusApproved, admin, "")
		}(i)
	}
	close(gun)
	wg.Wait()

	succeeded := 0
	conflicted := 0
	for _, err := range errs {
		switch {
		case err == nil:
			succeeded++
		case errors.Is(err, domain.ErrConflict):
			conflicted++
		default:
			t.Fatalf("unexpected concurrent error: %v", err)
		}
	}
	if succeeded != 1 || conflicted != 1 {
		t.Fatalf("succeeded=%d conflicted=%d, want exactly 1 and 1 (RED: both won or both lost)", succeeded, conflicted)
	}
	if rows := historyRows(t, pool, visitID); len(rows) != 1 {
		t.Fatalf("history rows = %d, want exactly 1", len(rows))
	}
}

// TestUpdateStatus_EmptyActorPersistsNull proves domain.UUID("") becomes SQL
// NULL in changed_by (automatic transitions have no acting user).
func TestUpdateStatus_EmptyActorPersistsNull(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	repos := NewVisitRepository(pool)

	loc := seedLocation(t, pool, "Cabang Hantu", "cabang")
	vendor := seedUser(t, pool, seedUserParams{Name: "Vendor Hantu", Email: "hantu@vendor.test", Role: "vendor", Type: "external"})

	start := time.Now().UTC().Add(-30 * 24 * time.Hour).Truncate(time.Second)
	visitID := seedVisit(t, pool, seedVisitParams{
		Code: "VST-0000000103", PIC: vendor, Location: loc,
		Start: start, End: start.Add(4 * time.Hour), Status: domain.VisitStatusRequested,
	})

	if err := repos.UpdateStatus(ctx, visitID, domain.VisitStatusCancelled, "", "auto-rule R1"); err != nil {
		t.Fatalf("UpdateStatus with empty actor: %v", err)
	}
	rows := historyRows(t, pool, visitID)
	if len(rows) != 1 {
		t.Fatalf("history rows = %d, want 1", len(rows))
	}
	if rows[0].ChangedBy.Valid {
		t.Fatalf("changed_by is set, want SQL NULL for the empty actor")
	}
}

// TestReschedule_UpdatesWindowAndHistoryAtomically proves the new window, the
// rescheduled status and the reason-note history row land together, and that a
// reversed window is rejected with the old window intact.
func TestReschedule_UpdatesWindowAndHistoryAtomically(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	repos := NewVisitRepository(pool)

	loc := seedLocation(t, pool, "Cabang Geser", "cabang")
	vendor := seedVendor(t, pool, "Vendor Geser")
	vendorUser := seedUser(t, pool, seedUserParams{Name: "Vendor Geser", Email: "geser@vendor.test", Role: "vendor", Type: "external"})
	admin := seedUser(t, pool, seedUserParams{Name: "Admin Geser", Email: "admin.geser@thc.test", Role: "admin", Location: loc, Type: "internal"})
	purpose := seedPurpose(t, pool, "Maintenance Genset")

	created, err := repos.Create(ctx, domain.VisitRequest{
		PICUserID:     vendorUser,
		VendorID:      vendor,
		LocationID:    loc,
		StartDate:     time.Now().UTC().Add(48 * time.Hour).Truncate(time.Second),
		EndDate:       time.Now().UTC().Add(52 * time.Hour).Truncate(time.Second),
		IsNDAAccepted: true,
	}, []domain.Visitor{{Name: "Teknisi Geser", IDNumber: "ID-1", Phone: "0811"}}, []domain.UUID{purpose})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	newStart := time.Now().UTC().Add(72 * time.Hour).Truncate(time.Second)
	newEnd := newStart.Add(6 * time.Hour)
	if err := repos.Reschedule(ctx, created.ID, newStart, newEnd, admin, "genset belum datang"); err != nil {
		t.Fatalf("Reschedule: %v", err)
	}
	got, err := repos.FindByID(ctx, created.ID)
	if err != nil {
		t.Fatalf("FindByID: %v", err)
	}
	if !got.StartDate.Equal(newStart) || !got.EndDate.Equal(newEnd) {
		t.Fatalf("window = [%v, %v], want [%v, %v]", got.StartDate, got.EndDate, newStart, newEnd)
	}
	if got.Status != domain.VisitStatusRescheduled {
		t.Fatalf("status = %s, want rescheduled", got.Status)
	}
	rows := historyRows(t, pool, created.ID)
	if len(rows) != 1 {
		t.Fatalf("history rows = %d, want exactly 1", len(rows))
	}
	if !rows[0].Notes.Valid || rows[0].Notes.String != "genset belum datang" {
		t.Fatalf("history note = %+v, want the reschedule reason", rows[0].Notes)
	}

	// Reversed window: the database CHECK rejects it and the old window stays.
	if err := repos.Reschedule(ctx, created.ID, newEnd, newStart, admin, "terbalik"); err == nil {
		t.Fatalf("reversed Reschedule succeeded, want a validation failure")
	}
	got, err = repos.FindByID(ctx, created.ID)
	if err != nil {
		t.Fatalf("FindByID after failed reschedule: %v", err)
	}
	if !got.StartDate.Equal(newStart) || !got.EndDate.Equal(newEnd) {
		t.Fatalf("window changed by failed reschedule: [%v, %v]", got.StartDate, got.EndDate)
	}
}
