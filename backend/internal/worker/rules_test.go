package worker_test

import (
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/worker"
)

func workerService(visits *fakeVisitRepo, rules *fakeAutoRules, checks *fakeCheckInOutRepo) *worker.Service {
	return worker.NewService(worker.Dependencies{
		Visits:   visits,
		Rules:    rules,
		CheckIns: checks,
		Clock:    &stubClock{now: workerNow},
	})
}

func TestRule1_AutoCancelsRequestedAfterSevenDays(t *testing.T) {
	t.Parallel()
	// Given: a requested visit created 8 days ago (past the 7d timeout).
	old := mkVisit("visit-r1", domain.VisitStatusRequested,
		workerNow.Add(-8*24*time.Hour), workerNow, workerNow.Add(2*time.Hour))
	visits := newFakeVisitRepo(old)
	rules := &fakeAutoRules{stale: []domain.VisitRequest{old}}
	svc := workerService(visits, rules, newFakeCheckInOutRepo())
	// When: the sweep runs.
	summary := svc.Run(t.Context())
	// Then: requested -> cancelled with no human actor.
	if summary.Cancelled != 1 {
		t.Fatalf("expected 1 cancellation, got %+v", summary)
	}
	if visits.visits[old.ID].Status != domain.VisitStatusCancelled {
		t.Fatalf("expected status cancelled, got %q", visits.visits[old.ID].Status)
	}
	if len(summary.Failures) != 0 {
		t.Fatalf("expected no failures, got %+v", summary.Failures)
	}
}

func TestRule1_BoundarySevenDays(t *testing.T) {
	t.Parallel()
	// Given: the R1 cut-off derived from the frozen clock.
	r1, _, _ := worker.Thresholds(workerNow)
	cases := []struct {
		name      string
		createdAt time.Time
		want      bool
	}{
		{"exactly 7d is stale and cancelled", r1, true},
		{"7d minus 1s is not yet stale", r1.Add(time.Second), false},
		{"8d is stale", workerNow.Add(-8 * 24 * time.Hour), true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			v := mkVisit("visit-r1b", domain.VisitStatusRequested,
				tc.createdAt, workerNow, workerNow.Add(2*time.Hour))
			if got := worker.ShouldAutoCancel(v, r1); got != tc.want {
				t.Fatalf("ShouldAutoCancel(created=%v) = %v, want %v", tc.createdAt, got, tc.want)
			}
		})
	}
}

func TestRule2_NoShowAfterWindowCloses(t *testing.T) {
	t.Parallel()
	// Given: an approved visit whose window closed (end 3h ago) with no check-in.
	noShow := mkVisit("visit-r2", domain.VisitStatusApproved,
		workerNow.Add(-24*time.Hour), workerNow.Add(-5*time.Hour), workerNow.Add(-3*time.Hour))
	visits := newFakeVisitRepo(noShow)
	rules := &fakeAutoRules{noShow: []domain.VisitRequest{noShow}}
	svc := workerService(visits, rules, newFakeCheckInOutRepo())
	// When: the sweep runs.
	summary := svc.Run(t.Context())
	// Then: approved -> not_visit.
	if summary.NoShow != 1 {
		t.Fatalf("expected 1 no-show, got %+v", summary)
	}
	if visits.visits[noShow.ID].Status != domain.VisitStatusNotVisit {
		t.Fatalf("expected status not_visit, got %q", visits.visits[noShow.ID].Status)
	}
}

func TestRule2_VisitWithCheckInRowIsNotFlipped(t *testing.T) {
	t.Parallel()
	// Given: an approved visit past the window that DOES have a check-in row
	// (e.g. checked in, status flip still pending).
	v := mkVisit("visit-r2in", domain.VisitStatusApproved,
		workerNow.Add(-24*time.Hour), workerNow.Add(-5*time.Hour), workerNow.Add(-3*time.Hour))
	visits := newFakeVisitRepo(v)
	rules := &fakeAutoRules{noShow: []domain.VisitRequest{v}}
	checks := newFakeCheckInOutRepo(domain.CheckIn{
		ID:             "checkin-visit-r2in",
		VisitRequestID: v.ID,
		CheckedInAt:    workerNow.Add(-4 * time.Hour),
		CheckedInBy:    "sec-1",
	})
	svc := workerService(visits, rules, checks)
	// When: the sweep runs.
	summary := svc.Run(t.Context())
	// Then: the visit is skipped, never flipped.
	if summary.NoShow != 0 {
		t.Fatalf("expected 0 no-shows, got %+v", summary)
	}
	if visits.visits[v.ID].Status != domain.VisitStatusApproved {
		t.Fatalf("expected status to stay approved, got %q", visits.visits[v.ID].Status)
	}
	if len(visits.writes) != 0 {
		t.Fatalf("expected zero status writes, got %d", len(visits.writes))
	}
}

func TestRule3_AutoCompletesAfterTwentyFourHours(t *testing.T) {
	t.Parallel()
	// Given: a visiting visit whose end was 25h ago.
	v := mkVisit("visit-r3", domain.VisitStatusVisiting,
		workerNow.Add(-48*time.Hour), workerNow.Add(-30*time.Hour), workerNow.Add(-25*time.Hour))
	visits := newFakeVisitRepo(v)
	rules := &fakeAutoRules{overstayed: []domain.VisitRequest{v}}
	svc := workerService(visits, rules, newFakeCheckInOutRepo())
	// When: the sweep runs.
	summary := svc.Run(t.Context())
	// Then: visiting -> completed.
	if summary.Completed != 1 {
		t.Fatalf("expected 1 auto-complete, got %+v", summary)
	}
	if visits.visits[v.ID].Status != domain.VisitStatusCompleted {
		t.Fatalf("expected status completed, got %q", visits.visits[v.ID].Status)
	}
}

func TestRule3_BoundaryTwentyFourHours(t *testing.T) {
	t.Parallel()
	// Given: the R3 cut-off derived from the frozen clock.
	_, _, r3 := worker.Thresholds(workerNow)
	cases := []struct {
		name    string
		endDate time.Time
		want    bool
	}{
		{"exactly 24h is completed", r3, true},
		{"24h minus 1s is not yet completed", r3.Add(time.Second), false},
		{"25h is completed", workerNow.Add(-25 * time.Hour), true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			v := mkVisit("visit-r3b", domain.VisitStatusVisiting,
				workerNow.Add(-48*time.Hour), tc.endDate.Add(-time.Hour), tc.endDate)
			if got := worker.ShouldAutoComplete(v, r3); got != tc.want {
				t.Fatalf("ShouldAutoComplete(end=%v) = %v, want %v", tc.endDate, got, tc.want)
			}
		})
	}
}

func TestRules_SkipVisitsWhoseStateChangedSinceTheSweep(t *testing.T) {
	t.Parallel()
	// Given: the sweep snapshot says requested, but the row has since been
	// approved — the worker must re-read and skip.
	snapshot := mkVisit("visit-stale", domain.VisitStatusRequested,
		workerNow.Add(-8*24*time.Hour), workerNow, workerNow.Add(2*time.Hour))
	current := snapshot
	current.Status = domain.VisitStatusApproved
	visits := newFakeVisitRepo(current)
	rules := &fakeAutoRules{stale: []domain.VisitRequest{snapshot}}
	svc := workerService(visits, rules, newFakeCheckInOutRepo())
	// When: the sweep runs.
	summary := svc.Run(t.Context())
	// Then: skipped, never flipped, no failure recorded.
	if summary.Cancelled != 0 {
		t.Fatalf("expected 0 cancellations, got %+v", summary)
	}
	if summary.Skipped != 1 {
		t.Fatalf("expected 1 skip, got %+v", summary)
	}
	if len(visits.writes) != 0 {
		t.Fatalf("expected zero status writes, got %d", len(visits.writes))
	}
	if len(summary.Failures) != 0 {
		t.Fatalf("a skip is not a failure, got %+v", summary.Failures)
	}
}

func TestRules_ContinueAfterOneVisitFails(t *testing.T) {
	t.Parallel()
	// Given: two stale requested visits; the first one's transition fails.
	bad := mkVisit("visit-bad", domain.VisitStatusRequested,
		workerNow.Add(-8*24*time.Hour), workerNow, workerNow.Add(2*time.Hour))
	good := mkVisit("visit-good", domain.VisitStatusRequested,
		workerNow.Add(-9*24*time.Hour), workerNow, workerNow.Add(2*time.Hour))
	visits := newFakeVisitRepo(bad, good)
	visits.updateErrs[bad.ID] = domain.ErrDatabase
	rules := &fakeAutoRules{stale: []domain.VisitRequest{bad, good}}
	svc := workerService(visits, rules, newFakeCheckInOutRepo())
	// When: the sweep runs.
	summary := svc.Run(t.Context())
	// Then: the bad row is collected, the good row still flips.
	if summary.Cancelled != 1 {
		t.Fatalf("expected 1 cancellation, got %+v", summary)
	}
	if len(summary.Failures) != 1 {
		t.Fatalf("expected 1 collected failure, got %+v", summary.Failures)
	}
	if visits.visits[good.ID].Status != domain.VisitStatusCancelled {
		t.Fatalf("expected good visit cancelled, got %q", visits.visits[good.ID].Status)
	}
	if visits.visits[bad.ID].Status != domain.VisitStatusRequested {
		t.Fatalf("expected bad visit to stay requested, got %q", visits.visits[bad.ID].Status)
	}
}

func TestRules_AutomaticTransitionUsesNoActor(t *testing.T) {
	t.Parallel()
	// Given: one stale requested visit.
	old := mkVisit("visit-noactor", domain.VisitStatusRequested,
		workerNow.Add(-8*24*time.Hour), workerNow, workerNow.Add(2*time.Hour))
	visits := newFakeVisitRepo(old)
	rules := &fakeAutoRules{stale: []domain.VisitRequest{old}}
	svc := workerService(visits, rules, newFakeCheckInOutRepo())
	// When: the sweep runs.
	_ = svc.Run(t.Context())
	// Then: the transition carries the empty actor id (persisted as SQL NULL).
	if len(visits.writes) != 1 {
		t.Fatalf("expected 1 status write, got %d", len(visits.writes))
	}
	if visits.writes[0].changedBy != domain.UUID("") {
		t.Fatalf("expected empty actor id, got %q", visits.writes[0].changedBy)
	}
}
