package gate_test

import (
	"errors"
	"testing"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/gate"
)

// TestCheckIn_RejectsMaliciousPhotoURL proves the gate reuses the visit
// upload allowlist: an otherwise-valid check-in carrying a javascript:
// photo_url is refused with a validation failure and zero writes.
func TestCheckIn_RejectsMaliciousPhotoURL(t *testing.T) {
	t.Parallel()
	// Given: an approved in-window visit on the actor's branch.
	start, end := openWindow()
	visit := visitFixture("visit-evilphoto", domain.VisitStatusApproved, start, end)
	visits := newFakeVisitRepo(visit)
	checks := newFakeCheckInOutRepo()
	svc := checkInService(visits, checks)
	actor := gate.Actor{ID: "sec-1", Role: domain.RoleSecurity, LocationID: uuidPtr("loc-A")}
	// When: check-in runs with a javascript: photo_url.
	evil := "javascript:alert(1)"
	_, err := svc.CheckIn(t.Context(), actor, string(visit.ID), gate.CheckInInput{PhotoURL: &evil})
	// Then: validation failure, zero writes.
	if err == nil {
		t.Fatal("expected javascript: photo_url to be rejected, got nil")
	}
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("expected ErrValidation, got %v", err)
	}
	if len(visits.writes) != 0 || len(checks.checkIns) != 0 {
		t.Fatalf("refused check-in must not write: %d status writes, %d check-ins",
			len(visits.writes), len(checks.checkIns))
	}
}
