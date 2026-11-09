package gate_test

import (
	"errors"
	"testing"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/gate"
)

// TestCheckIn_UnionMemberSucceedsDespiteScalarMismatch pins the membership
// widening: an admin whose stashed union covers the visit branch passes even
// when the scalar primary points elsewhere.
func TestCheckIn_UnionMemberSucceedsDespiteScalarMismatch(t *testing.T) {
	t.Parallel()
	// Given: an approved visit on loc-A inside its window.
	start, end := openWindow()
	visit := visitFixture("visit-union-in", domain.VisitStatusApproved, start, end)
	visits := newFakeVisitRepo(visit)
	checks := newFakeCheckInOutRepo()
	svc := checkInService(visits, checks)
	other := domain.UUID("loc-B")
	actor := gate.Actor{ID: "adm-1", Role: domain.RoleAdmin, LocationID: &other, Branches: []domain.UUID{visit.LocationID}}
	// When: the union member executes check-in.
	// Then: it succeeds.
	if _, err := svc.CheckIn(t.Context(), actor, string(visit.ID), gate.CheckInInput{}); err != nil {
		t.Fatalf("union member check-in refused: %v", err)
	}
}

// TestCheckIn_UnionNonMemberIsForbidden pins the fallback: outside both the
// union and the scalar primary, the guard refuses with 403.
func TestCheckIn_UnionNonMemberIsForbidden(t *testing.T) {
	t.Parallel()
	// Given: an approved visit on loc-A inside its window.
	start, end := openWindow()
	visit := visitFixture("visit-union-out", domain.VisitStatusApproved, start, end)
	visits := newFakeVisitRepo(visit)
	checks := newFakeCheckInOutRepo()
	svc := checkInService(visits, checks)
	foreign := domain.UUID("loc-B")
	union := domain.UUID("loc-C")
	actor := gate.Actor{ID: "adm-1", Role: domain.RoleAdmin, LocationID: &foreign, Branches: []domain.UUID{union}}
	// When: the non-member executes check-in.
	// Then: it is refused with the unchanged sentinel.
	if _, err := svc.CheckIn(t.Context(), actor, string(visit.ID), gate.CheckInInput{}); !errors.Is(err, domain.ErrForbiddenBranch) {
		t.Fatalf("error = %v, want ErrForbiddenBranch", err)
	}
}
