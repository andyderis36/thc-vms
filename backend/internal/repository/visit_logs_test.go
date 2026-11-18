package repository

// Multi-entry permit suite: one permit, N check-in/out cycles. Every gate
// edge writes exactly one visit_logs row in the same transaction as the status
// move, and terminal statuses refuse further gate entries.

import (
	"fmt"
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/repository/db"
)

// TestUpdateStatus_MultiEntrySequenceWritesOrderedLogs drives approved ->
// visiting -> offsite -> visiting -> offsite on one permit and asserts the
// four log rows carry the right direction, actor and timeline order.
func TestUpdateStatus_MultiEntrySequenceWritesOrderedLogs(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	repos := NewVisitRepository(pool)

	loc := seedLocation(t, pool, "Cabang Multi Entry", "cabang")
	vendor := seedUser(t, pool, seedUserParams{Name: "Vendor Multi", Email: "multi@vendor.test", Role: "vendor", Type: "external"})
	guard := seedUser(t, pool, seedUserParams{Name: "Pengawas Multi", Email: "guard.multi@thc.test", Role: "security", Location: loc, Type: "internal"})

	start := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
	visitID := seedVisit(t, pool, seedVisitParams{
		Code: "VST-0000000501", VendorUser: vendor, Location: loc,
		Start: start, End: start.Add(8 * time.Hour), Status: domain.VisitStatusApproved,
	})

	sequence := []struct {
		status    domain.VisitStatus
		direction string
	}{
		{domain.VisitStatusVisiting, "in"},
		{domain.VisitStatusOffsite, "out"},
		{domain.VisitStatusVisiting, "in"},
		{domain.VisitStatusOffsite, "out"},
	}
	for i, step := range sequence {
		if err := repos.UpdateStatus(ctx, visitID, step.status, guard, ""); err != nil {
			t.Fatalf("step %d UpdateStatus(%s): %v", i, step.status, err)
		}
		got, err := repos.FindByID(ctx, visitID)
		if err != nil {
			t.Fatalf("step %d FindByID: %v", i, err)
		}
		if got.Status != step.status {
			t.Fatalf("step %d status = %s, want %s", i, got.Status, step.status)
		}
	}

	parsed, err := fromDomainUUID(visitID)
	if err != nil {
		t.Fatalf("parse visit id: %v", err)
	}
	logs, err := db.New(pool).ListVisitLogsByVisit(ctx, db.ListVisitLogsByVisitParams{VisitRequestID: parsed})
	if err != nil {
		t.Fatalf("ListVisitLogsByVisit: %v", err)
	}
	if len(logs) != len(sequence) {
		t.Fatalf("log rows = %d, want %d (RED: an entry lost its log)", len(logs), len(sequence))
	}
	guardUUID, err := fromDomainUUID(guard)
	if err != nil {
		t.Fatalf("parse guard id: %v", err)
	}
	for i, log := range logs {
		if log.Direction != sequence[i].direction {
			t.Fatalf("log %d direction = %q, want %q", i, log.Direction, sequence[i].direction)
		}
		if !log.ActorUserID.Valid || log.ActorUserID.Bytes != guardUUID {
			t.Fatalf("log %d actor_user_id = %+v, want %s", i, log.ActorUserID, guard)
		}
		if !log.ActorRole.Valid || log.ActorRole.String != "security" {
			t.Fatalf("log %d actor_role = %+v, want security", i, log.ActorRole)
		}
		if i > 0 && log.CreatedAt.Before(logs[i-1].CreatedAt) {
			t.Fatalf("log %d created_at %v precedes log %d %v", i, log.CreatedAt, i-1, logs[i-1].CreatedAt)
		}
	}

	history := historyRows(t, pool, visitID)
	if len(history) != len(sequence) {
		t.Fatalf("history rows = %d, want %d", len(history), len(sequence))
	}
	for i, row := range history {
		if row.Status != string(sequence[i].status) {
			t.Fatalf("history %d status = %s, want %s", i, row.Status, sequence[i].status)
		}
	}
}

// TestUpdateStatus_TerminalStatusesRejectCheckIn proves a completed or
// cancelled permit cannot be re-entered and writes no log row on refusal.
func TestUpdateStatus_TerminalStatusesRejectCheckIn(t *testing.T) {
	for i, terminal := range []domain.VisitStatus{domain.VisitStatusCompleted, domain.VisitStatusCancelled} {
		t.Run(string(terminal), func(t *testing.T) {
			pool := testPool(t)
			resetTables(t, pool)
			ctx := testContext(t)
			repos := NewVisitRepository(pool)

			loc := seedLocation(t, pool, "Cabang Terminal", "cabang")
			vendor := seedUser(t, pool, seedUserParams{Name: "Vendor Terminal", Email: "terminal@vendor.test", Role: "vendor", Type: "external"})
			guard := seedUser(t, pool, seedUserParams{Name: "Pengawas Terminal", Email: "guard.terminal@thc.test", Role: "security", Location: loc, Type: "internal"})

			start := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
			visitID := seedVisit(t, pool, seedVisitParams{
				Code: fmt.Sprintf("VST-%010d", 502+i), VendorUser: vendor, Location: loc,
				Start: start, End: start.Add(4 * time.Hour), Status: terminal,
			})

			err := repos.UpdateStatus(ctx, visitID, domain.VisitStatusVisiting, guard, "")
			requireErrIs(t, err, domain.ErrInvalidTransition, "check-in on "+string(terminal))

			got, err := repos.FindByID(ctx, visitID)
			if err != nil {
				t.Fatalf("FindByID: %v", err)
			}
			if got.Status != terminal {
				t.Fatalf("status = %s, want unchanged %s", got.Status, terminal)
			}
			parsed, err := fromDomainUUID(visitID)
			if err != nil {
				t.Fatalf("parse visit id: %v", err)
			}
			logs, err := db.New(pool).ListVisitLogsByVisit(ctx, db.ListVisitLogsByVisitParams{VisitRequestID: parsed})
			if err != nil {
				t.Fatalf("ListVisitLogsByVisit: %v", err)
			}
			if len(logs) != 0 {
				t.Fatalf("log rows = %d, want 0 after refused check-in", len(logs))
			}
		})
	}
}

// TestUpdateStatus_CheckOutRequiresVisiting proves an approved permit cannot
// check out before it checks in, and a second check-in without a check-out is
// refused as a conflict.
func TestUpdateStatus_CheckOutRequiresVisiting(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	repos := NewVisitRepository(pool)

	loc := seedLocation(t, pool, "Cabang Urutan", "cabang")
	vendor := seedUser(t, pool, seedUserParams{Name: "Vendor Urutan", Email: "urutan@vendor.test", Role: "vendor", Type: "external"})
	guard := seedUser(t, pool, seedUserParams{Name: "Pengawas Urutan", Email: "guard.urutan@thc.test", Role: "security", Location: loc, Type: "internal"})

	start := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
	visitID := seedVisit(t, pool, seedVisitParams{
		Code: "VST-0000000503", VendorUser: vendor, Location: loc,
		Start: start, End: start.Add(4 * time.Hour), Status: domain.VisitStatusApproved,
	})

	requireErrIs(t, repos.UpdateStatus(ctx, visitID, domain.VisitStatusOffsite, guard, ""),
		domain.ErrInvalidTransition, "check-out without check-in")

	if err := repos.UpdateStatus(ctx, visitID, domain.VisitStatusVisiting, guard, ""); err != nil {
		t.Fatalf("first check-in: %v", err)
	}
	requireErrIs(t, repos.UpdateStatus(ctx, visitID, domain.VisitStatusVisiting, guard, ""),
		domain.ErrConflict, "double check-in without check-out")

	parsed, err := fromDomainUUID(visitID)
	if err != nil {
		t.Fatalf("parse visit id: %v", err)
	}
	logs, err := db.New(pool).ListVisitLogsByVisit(ctx, db.ListVisitLogsByVisitParams{VisitRequestID: parsed})
	if err != nil {
		t.Fatalf("ListVisitLogsByVisit: %v", err)
	}
	if len(logs) != 1 || logs[0].Direction != "in" {
		t.Fatalf("logs = %+v, want exactly one 'in' row", logs)
	}
}
