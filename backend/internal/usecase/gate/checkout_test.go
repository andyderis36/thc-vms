package gate_test

import (
	"errors"
	"testing"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/gate"
)

func TestCheckOut_SuccessMovesVisitingToCompleted(t *testing.T) {
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
	// Then: visiting -> completed with a check-out row.
	if err != nil {
		t.Fatalf("expected check-out to succeed, got %v", err)
	}
	if got.VisitRequestID != visit.ID {
		t.Fatalf("expected check-out for %q, got %q", visit.ID, got.VisitRequestID)
	}
	if got.CheckedOutBy != actor.ID {
		t.Fatalf("expected checked-out by %q, got %q", actor.ID, got.CheckedOutBy)
	}
	if visits.visits[visit.ID].Status != domain.VisitStatusCompleted {
		t.Fatalf("expected status completed, got %q", visits.visits[visit.ID].Status)
	}
}

func TestCheckOut_RequiresVisitingState(t *testing.T) {
	t.Parallel()
	// Given: visits in every non-visiting status.
	statuses := []domain.VisitStatus{
		domain.VisitStatusRequested,
		domain.VisitStatusApproved,
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

func TestCheckOut_DoubleCheckoutReturnsConflict(t *testing.T) {
	t.Parallel()
	// Given: a visiting visit that already has a check-out row.
	start, end := openWindow()
	visit := visitFixture("visit-double-out", domain.VisitStatusVisiting, start, end)
	visits := newFakeVisitRepo(visit)
	checks := newFakeCheckInOutRepo()
	checks.checkOuts[visit.ID] = domain.CheckOut{
		ID:             "checkout-visit-double-out",
		VisitRequestID: visit.ID,
		CheckedOutAt:   fixedNow,
		CheckedOutBy:   "sec-1",
	}
	svc := checkInService(visits, checks)
	actor := gate.Actor{ID: "sec-1", Role: domain.RoleSecurity, LocationID: uuidPtr("loc-A")}
	// When: a second check-out runs.
	_, err := svc.CheckOut(t.Context(), actor, visit.ID)
	// Then: conflict.
	if err == nil {
		t.Fatal("expected double check-out to conflict, got nil")
	}
	if !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("expected ErrConflict, got %v", err)
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
		{"vendor is forbidden", gate.Actor{ID: "pic-1", Role: domain.RoleVendor}},
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
