package gate_test

import (
	"errors"
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/gate"
)

// TestCheckOut_SuccessMovesVisitingToOffsite pins the multi-entry check-out:
// leaving the gate sends the team off site while the permit stays active, so
// the team can re-enter. Completion now belongs to R3/Selesaikan only.
func TestCheckOut_SuccessMovesVisitingToOffsite(t *testing.T) {
	t.Parallel()
	// Given: a visiting visit on the actor's branch (no window applies).
	start, end := openWindow()
	visit := visitFixture("visit-out", domain.VisitStatusVisiting, start, end)
	visits := newFakeVisitRepo(visit)
	checks := newFakeCheckInOutRepo()
	svc := checkInService(visits, checks)
	actor := gate.Actor{ID: "sec-1", Role: domain.RoleSecurity, LocationID: uuidPtr("loc-A")}
	// When: check-out runs.
	got, err := svc.CheckOut(t.Context(), actor, visit.ID)
	// Then: visiting -> offsite with a check-out row.
	if err != nil {
		t.Fatalf("expected check-out to succeed, got %v", err)
	}
	if got.VisitRequestID != visit.ID {
		t.Fatalf("expected check-out for %q, got %q", visit.ID, got.VisitRequestID)
	}
	if got.CheckedOutBy != actor.ID {
		t.Fatalf("expected checked-out by %q, got %q", actor.ID, got.CheckedOutBy)
	}
	if visits.visits[visit.ID].Status != domain.VisitStatusOffsite {
		t.Fatalf("expected status offsite, got %q", visits.visits[visit.ID].Status)
	}
}

func TestCheckOut_RequiresVisitingState(t *testing.T) {
	t.Parallel()
	// Given: visits in every non-visiting status.
	statuses := []domain.VisitStatus{
		domain.VisitStatusRequested,
		domain.VisitStatusApproved,
		domain.VisitStatusOffsite,
		domain.VisitStatusCompleted,
		domain.VisitStatusNotVisit,
		domain.VisitStatusRejected,
		domain.VisitStatusCancelled,
		domain.VisitStatusRescheduled,
	}
	for _, status := range statuses {
		t.Run(string(status), func(t *testing.T) {
			t.Parallel()
			start, end := openWindow()
			visit := visitFixture(domain.UUID("visit-co-"+status), status, start, end)
			visits := newFakeVisitRepo(visit)
			checks := newFakeCheckInOutRepo()
			svc := checkInService(visits, checks)
			actor := gate.Actor{ID: "sec-1", Role: domain.RoleSecurity, LocationID: uuidPtr("loc-A")}
			// When: check-out runs outside visiting.
			_, err := svc.CheckOut(t.Context(), actor, visit.ID)
			// Then: conflict, no writes.
			if err == nil {
				t.Fatalf("expected status %q to refuse check-out, got nil", status)
			}
			if !errors.Is(err, domain.ErrConflict) {
				t.Fatalf("expected ErrConflict for status %q, got %v", status, err)
			}
			if len(visits.writes) != 0 || len(checks.checkOuts) != 0 {
				t.Fatalf("refused check-out must not write: %d status writes, %d check-outs",
					len(visits.writes), len(checks.checkOuts))
			}
		})
	}
}

// TestCheckOut_SubsequentCycleWithExistingRowSucceeds pins the legacy-UNIQUE
// tolerance on a subsequent cycle: the first cycle already wrote a check_out
// row, so this cycle's RecordCheckOut hits UNIQUE(visit_request_id). The gate
// reuses that row and still moves visiting -> offsite. Same-direction double
// scans are NOT handled here — the state guard refuses them, because a
// completed check-out leaves the permit offsite (see the double-scan test).
func TestCheckOut_SubsequentCycleWithExistingRowSucceeds(t *testing.T) {
	t.Parallel()
	// Given: a visiting visit whose first cycle left a check-out row behind.
	start, end := openWindow()
	visit := visitFixture("visit-subsequent-out", domain.VisitStatusVisiting, start, end)
	visits := newFakeVisitRepo(visit)
	checks := newFakeCheckInOutRepo()
	existing := domain.CheckOut{
		ID:             "checkout-visit-subsequent-out",
		VisitRequestID: visit.ID,
		CheckedOutAt:   fixedNow.Add(-2 * time.Hour),
		CheckedOutBy:   "sec-1",
	}
	checks.checkOuts[visit.ID] = existing
	svc := checkInService(visits, checks)
	actor := gate.Actor{ID: "sec-1", Role: domain.RoleSecurity, LocationID: uuidPtr("loc-A")}
	// When: the team checks out again on a later cycle.
	got, err := svc.CheckOut(t.Context(), actor, visit.ID)
	// Then: the existing row is returned and the permit still moves to offsite.
	if err != nil {
		t.Fatalf("expected subsequent-cycle check-out to succeed, got %v", err)
	}
	if got.ID != existing.ID {
		t.Fatalf("expected existing check-out %q, got %q", existing.ID, got.ID)
	}
	if visits.visits[visit.ID].Status != domain.VisitStatusOffsite {
		t.Fatalf("expected status offsite, got %q", visits.visits[visit.ID].Status)
	}
	if len(visits.writes) != 1 || visits.writes[0].status != domain.VisitStatusOffsite {
		t.Fatalf("writes = %+v, want exactly one move to offsite", visits.writes)
	}
}

// TestCheckOut_DoubleScanRejectedByStateGuard pins that same-direction double
// scans stay a clean 4xx at the state guard: after the first check-out moves
// the permit to offsite, a second scan is refused before any record write,
// even though a check-out row already exists.
func TestCheckOut_DoubleScanRejectedByStateGuard(t *testing.T) {
	t.Parallel()
	start, end := openWindow()
	visit := visitFixture("visit-co-double-scan", domain.VisitStatusVisiting, start, end)
	visits := newFakeVisitRepo(visit)
	checks := newFakeCheckInOutRepo()
	svc := checkInService(visits, checks)
	actor := gate.Actor{ID: "sec-1", Role: domain.RoleSecurity, LocationID: uuidPtr("loc-A")}
	// When: the same QR is scanned twice in a row without a re-entry check-in.
	if _, err := svc.CheckOut(t.Context(), actor, visit.ID); err != nil {
		t.Fatalf("first check-out failed: %v", err)
	}
	_, err := svc.CheckOut(t.Context(), actor, visit.ID)
	// Then: the second scan is a clean conflict with no extra writes.
	if err == nil {
		t.Fatal("expected second check-out to be refused by the state guard, got nil")
	}
	if !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("expected ErrConflict, got %v", err)
	}
	if len(visits.writes) != 1 || len(checks.checkOuts) != 1 {
		t.Fatalf("double scan must not write again: %d status writes, %d check-outs",
			len(visits.writes), len(checks.checkOuts))
	}
}

func TestCheckOut_ForbiddenActorAndBranch(t *testing.T) {
	t.Parallel()
	// Given: a visiting visit on loc-B.
	start, end := openWindow()
	newVisit := func() domain.VisitRequest {
		v := visitFixture("visit-co-guard", domain.VisitStatusVisiting, start, end)
		v.LocationID = "loc-B"
		return v
	}
	actors := []struct {
		name  string
		actor gate.Actor
	}{
		{"vendor is forbidden", gate.Actor{ID: "vendor-1", Role: domain.RoleVendor}},
		{"security on another branch is forbidden", gate.Actor{ID: "sec-1", Role: domain.RoleSecurity, LocationID: uuidPtr("loc-A")}},
		{"admin on another branch is forbidden", gate.Actor{ID: "adm-1", Role: domain.RoleAdmin, LocationID: uuidPtr("loc-A")}},
	}
	for _, tc := range actors {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			visit := newVisit()
			visits := newFakeVisitRepo(visit)
			checks := newFakeCheckInOutRepo()
			svc := checkInService(visits, checks)
			// When: check-out runs without branch authority.
			_, err := svc.CheckOut(t.Context(), tc.actor, visit.ID)
			// Then: branch refusal, zero writes.
			if err == nil {
				t.Fatal("expected forbidden check-out, got nil")
			}
			if !errors.Is(err, domain.ErrForbiddenBranch) {
				t.Fatalf("expected ErrForbiddenBranch, got %v", err)
			}
			if len(visits.writes) != 0 || len(checks.checkOuts) != 0 {
				t.Fatalf("refused check-out must not write: %d status writes, %d check-outs",
					len(visits.writes), len(checks.checkOuts))
			}
		})
	}
}

func TestCheckOut_MissingVisitReturnsNotFound(t *testing.T) {
	t.Parallel()
	// Given: an empty repository.
	visits := newFakeVisitRepo()
	checks := newFakeCheckInOutRepo()
	svc := checkInService(visits, checks)
	actor := gate.Actor{ID: "sec-1", Role: domain.RoleSecurity, LocationID: uuidPtr("loc-A")}
	// When: check-out targets an unknown id.
	_, err := svc.CheckOut(t.Context(), actor, "visit-ghost")
	// Then: NotFoundEntity("Kunjungan").
	if err == nil {
		t.Fatal("expected not-found, got nil")
	}
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}
