package worker_test

// Multi-entry worker suite: R3 closes active permits exactly at end datetime
// (visiting or offsite), R2 auto-cancels every pre-arrival status (approved,
// rescheduled, and requested past R1's end guard) with zero entries, and R1
// keeps its original requested-at-start behaviour.

import (
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
)

func TestRule3_ExactEndBoundarySweep(t *testing.T) {
	t.Parallel()
	// Given: two visiting permits, one ending one second from now and one
	// that ended one second ago. Both are listed as R3 candidates.
	alive := mkVisit("visit-r3-alive", domain.VisitStatusVisiting,
		workerNow.Add(-2*time.Hour), workerNow.Add(-time.Hour), workerNow.Add(time.Second))
	due := mkVisit("visit-r3-due", domain.VisitStatusVisiting,
		workerNow.Add(-2*time.Hour), workerNow.Add(-time.Hour), workerNow.Add(-time.Second))
	visits := newFakeVisitRepo(alive, due)
	rules := &fakeAutoRules{overstayed: []domain.VisitRequest{alive, due}}
	svc := workerService(visits, rules, newFakeCheckInOutRepo())
	// When: the sweep runs at the frozen clock.
	summary := svc.Run(t.Context())
	// Then: only the permit whose end has passed is completed.
	if summary.Completed != 1 {
		t.Fatalf("expected 1 auto-complete, got %+v", summary)
	}
	if visits.visits[alive.ID].Status != domain.VisitStatusVisiting {
		t.Fatalf("end-1s permit status = %q, want visiting", visits.visits[alive.ID].Status)
	}
	if visits.visits[due.ID].Status != domain.VisitStatusCompleted {
		t.Fatalf("end+1s permit status = %q, want completed", visits.visits[due.ID].Status)
	}
}

func TestRule3_OffsiteCompletesAtEnd(t *testing.T) {
	t.Parallel()
	// Given: a checked-out permit (offsite) whose end datetime has arrived.
	v := mkVisit("visit-r3-offsite", domain.VisitStatusOffsite,
		workerNow.Add(-2*time.Hour), workerNow.Add(-time.Hour), workerNow.Add(-time.Second))
	visits := newFakeVisitRepo(v)
	rules := &fakeAutoRules{overstayed: []domain.VisitRequest{v}}
	svc := workerService(visits, rules, newFakeCheckInOutRepo())
	// When: the sweep runs.
	summary := svc.Run(t.Context())
	// Then: offsite -> completed with the System actor and the R3 note.
	if summary.Completed != 1 {
		t.Fatalf("expected 1 auto-complete, got %+v", summary)
	}
	if visits.visits[v.ID].Status != domain.VisitStatusCompleted {
		t.Fatalf("status = %q, want completed", visits.visits[v.ID].Status)
	}
	if len(visits.writes) != 1 {
		t.Fatalf("status writes = %d, want 1", len(visits.writes))
	}
	write := visits.writes[0]
	if write.changedBy != domain.UUID("") {
		t.Fatalf("changedBy = %q, want the empty System actor", write.changedBy)
	}
	if write.notes != "Otomatis diselesaikan: akhir jadwal telah tiba (R3)." {
		t.Fatalf("notes = %q, want the R3 auto-complete note", write.notes)
	}
}

func TestRule2_ZeroEntryAutoCancelsAtEnd(t *testing.T) {
	t.Parallel()
	// Given: an approved permit at end datetime with no entry row.
	v := mkVisit("visit-r2-unused", domain.VisitStatusApproved,
		workerNow.Add(-2*time.Hour), workerNow.Add(-time.Hour), workerNow.Add(-time.Second))
	visits := newFakeVisitRepo(v)
	rules := &fakeAutoRules{noShow: []domain.VisitRequest{v}}
	svc := workerService(visits, rules, newFakeCheckInOutRepo())
	// When: the sweep runs.
	summary := svc.Run(t.Context())
	// Then: approved -> cancelled with the System actor and the R2 note.
	if summary.NoShow != 1 {
		t.Fatalf("expected 1 auto-cancel, got %+v", summary)
	}
	if visits.visits[v.ID].Status != domain.VisitStatusCancelled {
		t.Fatalf("status = %q, want cancelled", visits.visits[v.ID].Status)
	}
	if len(visits.writes) != 1 {
		t.Fatalf("status writes = %d, want 1", len(visits.writes))
	}
	write := visits.writes[0]
	if write.changedBy != domain.UUID("") {
		t.Fatalf("changedBy = %q, want the empty System actor", write.changedBy)
	}
	if write.notes != "Otomatis dibatalkan: tidak ada check-in hingga akhir jadwal (R2)." {
		t.Fatalf("notes = %q, want the R2 auto-cancel note", write.notes)
	}
}

func TestRule2_WithEntryIsLeftToR3(t *testing.T) {
	t.Parallel()
	// Given: a permit that already checked in (visiting + a check-in row) at
	// end datetime, listed on both the R2 and R3 candidate lists.
	v := mkVisit("visit-r2-used", domain.VisitStatusVisiting,
		workerNow.Add(-2*time.Hour), workerNow.Add(-time.Hour), workerNow.Add(-time.Second))
	checks := newFakeCheckInOutRepo(domain.CheckIn{
		ID: "checkin-r2-used", VisitRequestID: v.ID,
		CheckedInAt: workerNow.Add(-90 * time.Minute), CheckedInBy: "sec-1",
	})
	visits := newFakeVisitRepo(v)
	rules := &fakeAutoRules{noShow: []domain.VisitRequest{v}, overstayed: []domain.VisitRequest{v}}
	svc := workerService(visits, rules, checks)
	// When: the sweep runs.
	summary := svc.Run(t.Context())
	// Then: R2 leaves it alone and R3 completes it.
	if summary.NoShow != 0 {
		t.Fatalf("expected 0 auto-cancels, got %+v", summary)
	}
	if summary.Completed != 1 {
		t.Fatalf("expected 1 auto-complete, got %+v", summary)
	}
	if visits.visits[v.ID].Status != domain.VisitStatusCompleted {
		t.Fatalf("status = %q, want completed", visits.visits[v.ID].Status)
	}
}

func TestRules_R1StillCancelsRequestedAtStart(t *testing.T) {
	t.Parallel()
	// Given: a requested visit whose window started, alongside an approved
	// zero-entry permit at end and a visiting permit at end.
	requested := mkVisit("visit-r1-keep", domain.VisitStatusRequested,
		workerNow.Add(-2*time.Hour), workerNow.Add(-time.Hour), workerNow.Add(time.Hour))
	unused := mkVisit("visit-r2-keep", domain.VisitStatusApproved,
		workerNow.Add(-2*time.Hour), workerNow.Add(-time.Hour), workerNow.Add(-time.Second))
	active := mkVisit("visit-r3-keep", domain.VisitStatusVisiting,
		workerNow.Add(-2*time.Hour), workerNow.Add(-time.Hour), workerNow.Add(-time.Second))
	visits := newFakeVisitRepo(requested, unused, active)
	rules := &fakeAutoRules{
		stale:      []domain.VisitRequest{requested},
		noShow:     []domain.VisitRequest{unused},
		overstayed: []domain.VisitRequest{active},
	}
	svc := workerService(visits, rules, newFakeCheckInOutRepo())
	// When: the sweep runs.
	summary := svc.Run(t.Context())
	// Then: each rule owns its own source status and the counts stay disjoint.
	if summary.Cancelled != 1 || summary.NoShow != 1 || summary.Completed != 1 {
		t.Fatalf("cancelled=%d no_show=%d completed=%d, want 1/1/1", summary.Cancelled, summary.NoShow, summary.Completed)
	}
	if visits.visits[requested.ID].Status != domain.VisitStatusCancelled {
		t.Fatalf("R1 status = %q, want cancelled", visits.visits[requested.ID].Status)
	}
	if visits.visits[unused.ID].Status != domain.VisitStatusCancelled {
		t.Fatalf("R2 status = %q, want cancelled", visits.visits[unused.ID].Status)
	}
	if visits.visits[active.ID].Status != domain.VisitStatusCompleted {
		t.Fatalf("R3 status = %q, want completed", visits.visits[active.ID].Status)
	}
}
