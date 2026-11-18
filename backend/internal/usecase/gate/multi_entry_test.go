package gate_test

import (
	"errors"
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/gate"
)

// TestCheckIn_ReEntryFromOffsiteSucceeds pins the multi-entry re-entry edge:
// an offsite permit inside its window admits another check-in back to visiting
// (plan section 5). The first-entry approved edge stays intact.
func TestCheckIn_ReEntryFromOffsiteSucceeds(t *testing.T) {
	t.Parallel()
	start, end := openWindow()
	visit := visitFixture("visit-reentry", domain.VisitStatusOffsite, start, end)
	visits := newFakeVisitRepo(visit)
	checks := newFakeCheckInOutRepo()
	svc := checkInService(visits, checks)
	actor := gate.Actor{ID: "sec-1", Role: domain.RoleSecurity, LocationID: uuidPtr("loc-A")}
	// When: security scans the QR of a permit that is currently offsite.
	got, err := svc.CheckIn(t.Context(), actor, string(visit.ID), gate.CheckInInput{})
	// Then: offsite -> visiting with a check-in row attributed to the actor.
	if err != nil {
		t.Fatalf("expected re-entry check-in to succeed, got %v", err)
	}
	if got.CheckedInBy != actor.ID {
		t.Fatalf("expected checked-in by %q, got %q", actor.ID, got.CheckedInBy)
	}
	if visits.visits[visit.ID].Status != domain.VisitStatusVisiting {
		t.Fatalf("expected status visiting, got %q", visits.visits[visit.ID].Status)
	}
	if len(visits.writes) != 1 || visits.writes[0].status != domain.VisitStatusVisiting {
		t.Fatalf("writes = %+v, want exactly one move to visiting", visits.writes)
	}
}

// TestCheckIn_ReEntryWithExistingRowSucceeds pins the legacy-UNIQUE tolerance
// on re-entry: the first entry already wrote a check_in row, so this entry's
// RecordCheckIn hits UNIQUE(visit_request_id). The gate reuses that row and
// still completes the offsite -> visiting move. A first entry (approved) has
// no row to reuse and must surface the conflict (see the double-check-in test).
func TestCheckIn_ReEntryWithExistingRowSucceeds(t *testing.T) {
	t.Parallel()
	start, end := openWindow()
	visit := visitFixture("visit-reentry-existing", domain.VisitStatusOffsite, start, end)
	visits := newFakeVisitRepo(visit)
	checks := newFakeCheckInOutRepo()
	existing := domain.CheckIn{
		ID:             "checkin-visit-reentry-existing",
		VisitRequestID: visit.ID,
		CheckedInAt:    fixedNow.Add(-2 * time.Hour),
		CheckedInBy:    "sec-1",
	}
	checks.checkIns[visit.ID] = existing
	svc := checkInService(visits, checks)
	actor := gate.Actor{ID: "sec-1", Role: domain.RoleSecurity, LocationID: uuidPtr("loc-A")}
	// When: security scans the QR of an offsite permit whose first entry left
	// a check-in row behind.
	got, err := svc.CheckIn(t.Context(), actor, string(visit.ID), gate.CheckInInput{})
	// Then: the existing row is returned and the permit moves back to visiting.
	if err != nil {
		t.Fatalf("expected re-entry with existing row to succeed, got %v", err)
	}
	if got.ID != existing.ID {
		t.Fatalf("expected existing check-in %q, got %q", existing.ID, got.ID)
	}
	if visits.visits[visit.ID].Status != domain.VisitStatusVisiting {
		t.Fatalf("expected status visiting, got %q", visits.visits[visit.ID].Status)
	}
	if len(visits.writes) != 1 || visits.writes[0].status != domain.VisitStatusVisiting {
		t.Fatalf("writes = %+v, want exactly one move to visiting", visits.writes)
	}
}

// TestCheckIn_ReEntryOutsideWindowIsRefused pins that re-entry obeys the same
// [start-2h, end] window as the first entry.
func TestCheckIn_ReEntryOutsideWindowIsRefused(t *testing.T) {
	t.Parallel()
	visit := visitFixture("visit-reentry-late", domain.VisitStatusOffsite,
		fixedNow.Add(-4*time.Hour), fixedNow.Add(-time.Hour))
	visits := newFakeVisitRepo(visit)
	checks := newFakeCheckInOutRepo()
	svc := checkInService(visits, checks)
	actor := gate.Actor{ID: "sec-1", Role: domain.RoleSecurity, LocationID: uuidPtr("loc-A")}
	// When: an offsite permit whose end has passed is scanned.
	_, err := svc.CheckIn(t.Context(), actor, string(visit.ID), gate.CheckInInput{})
	// Then: window refusal, zero writes.
	if !errors.Is(err, domain.ErrCheckInWindow) {
		t.Fatalf("expected ErrCheckInWindow, got %v", err)
	}
	if len(visits.writes) != 0 || len(checks.checkIns) != 0 {
		t.Fatalf("refused re-entry must not write: %d status writes, %d check-ins",
			len(visits.writes), len(checks.checkIns))
	}
}

// TestCheckOut_PastEndStillSucceeds pins that check-out has NO window upper
// bound: the team may still be on site past end_date, and R3/Selesaikan (not
// the gate scan) closes the permit (plan section 3).
func TestCheckOut_PastEndStillSucceeds(t *testing.T) {
	t.Parallel()
	visit := visitFixture("visit-out-past-end", domain.VisitStatusVisiting,
		fixedNow.Add(-4*time.Hour), fixedNow.Add(-time.Hour))
	visits := newFakeVisitRepo(visit)
	checks := newFakeCheckInOutRepo()
	svc := checkInService(visits, checks)
	actor := gate.Actor{ID: "sec-1", Role: domain.RoleSecurity, LocationID: uuidPtr("loc-A")}
	// When: check-out runs one hour after the permit's end datetime.
	got, err := svc.CheckOut(t.Context(), actor, visit.ID)
	// Then: it succeeds and moves the permit to offsite.
	if err != nil {
		t.Fatalf("expected past-end check-out to succeed, got %v", err)
	}
	if got.CheckedOutBy != actor.ID {
		t.Fatalf("expected checked-out by %q, got %q", actor.ID, got.CheckedOutBy)
	}
	if visits.visits[visit.ID].Status != domain.VisitStatusOffsite {
		t.Fatalf("expected status offsite, got %q", visits.visits[visit.ID].Status)
	}
}

// TestCompleteVisit_FromVisitingAndOffsiteSucceeds pins the manual Selesaikan
// action: a branch admin closes an active permit from either on-site state,
// and the human actor id flows into UpdateStatus so the repository resolves
// the name/role label and emits the ordinary (non-Otomatis) completed template.
func TestCompleteVisit_FromVisitingAndOffsiteSucceeds(t *testing.T) {
	t.Parallel()
	for _, status := range []domain.VisitStatus{domain.VisitStatusVisiting, domain.VisitStatusOffsite} {
		t.Run(string(status), func(t *testing.T) {
			t.Parallel()
			start, end := openWindow()
			visit := visitFixture(domain.UUID("visit-complete-"+status), status, start, end)
			visits := newFakeVisitRepo(visit)
			checks := newFakeCheckInOutRepo()
			svc := checkInService(visits, checks)
			actor := gate.Actor{ID: "adm-1", Role: domain.RoleAdmin, LocationID: uuidPtr("loc-A")}
			// When: the branch admin completes the permit by hand.
			err := svc.CompleteVisit(t.Context(), actor, visit.ID)
			// Then: completed with the human actor recorded, no gate log row.
			if err != nil {
				t.Fatalf("expected complete from %q to succeed, got %v", status, err)
			}
			if visits.visits[visit.ID].Status != domain.VisitStatusCompleted {
				t.Fatalf("expected status completed, got %q", visits.visits[visit.ID].Status)
			}
			if len(visits.writes) != 1 || visits.writes[0].changedBy != actor.ID {
				t.Fatalf("writes = %+v, want one move to completed by %q", visits.writes, actor.ID)
			}
			if len(checks.checkIns) != 0 || len(checks.checkOuts) != 0 {
				t.Fatalf("completion must not write gate logs: %d check-ins, %d check-outs",
					len(checks.checkIns), len(checks.checkOuts))
			}
		})
	}
}

// TestCompleteVisit_AnytimeIncludingPastEnd pins that manual completion is not
// window-bound: staff may close a permit after its end datetime.
func TestCompleteVisit_AnytimeIncludingPastEnd(t *testing.T) {
	t.Parallel()
	visit := visitFixture("visit-complete-past-end", domain.VisitStatusOffsite,
		fixedNow.Add(-6*time.Hour), fixedNow.Add(-2*time.Hour))
	visits := newFakeVisitRepo(visit)
	checks := newFakeCheckInOutRepo()
	svc := checkInService(visits, checks)
	actor := gate.Actor{ID: "adm-1", Role: domain.RoleAdmin, LocationID: uuidPtr("loc-A")}
	// When: the admin completes a permit whose window closed two hours ago.
	err := svc.CompleteVisit(t.Context(), actor, visit.ID)
	// Then: it succeeds.
	if err != nil {
		t.Fatalf("expected past-end completion to succeed, got %v", err)
	}
	if visits.visits[visit.ID].Status != domain.VisitStatusCompleted {
		t.Fatalf("expected status completed, got %q", visits.visits[visit.ID].Status)
	}
}

// TestCompleteVisit_RejectsNonActiveStates pins that only visiting/offsite may
// be completed: approved, terminal and pre-arrival states are refused cleanly.
func TestCompleteVisit_RejectsNonActiveStates(t *testing.T) {
	t.Parallel()
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
			visit := visitFixture(domain.UUID("visit-complete-"+status), status, start, end)
			visits := newFakeVisitRepo(visit)
			checks := newFakeCheckInOutRepo()
			svc := checkInService(visits, checks)
			actor := gate.Actor{ID: "adm-1", Role: domain.RoleAdmin, LocationID: uuidPtr("loc-A")}
			// When: the admin tries to complete a non-active permit.
			err := svc.CompleteVisit(t.Context(), actor, visit.ID)
			// Then: conflict, zero writes.
			if !errors.Is(err, domain.ErrConflict) {
				t.Fatalf("expected ErrConflict for status %q, got %v", status, err)
			}
			if len(visits.writes) != 0 {
				t.Fatalf("refused completion must not write statuses, got %d", len(visits.writes))
			}
		})
	}
}

// TestCompleteVisit_RejectsNonAdminRoles pins that security and vendor can
// never complete a permit: the manual action is admin/super_admin only.
func TestCompleteVisit_RejectsNonAdminRoles(t *testing.T) {
	t.Parallel()
	actors := []struct {
		name  string
		actor gate.Actor
	}{
		{"security", gate.Actor{ID: "sec-1", Role: domain.RoleSecurity, LocationID: uuidPtr("loc-A")}},
		{"vendor", gate.Actor{ID: "vendor-1", Role: domain.RoleVendor}},
	}
	for _, tc := range actors {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			start, end := openWindow()
			visit := visitFixture(domain.UUID("visit-complete-role-"+tc.name), domain.VisitStatusVisiting, start, end)
			visits := newFakeVisitRepo(visit)
			checks := newFakeCheckInOutRepo()
			svc := checkInService(visits, checks)
			// When: a non-admin tries to complete the permit.
			err := svc.CompleteVisit(t.Context(), tc.actor, visit.ID)
			// Then: role refusal, zero writes.
			if !errors.Is(err, domain.ErrForbidden) {
				t.Fatalf("expected ErrForbidden for %q, got %v", tc.name, err)
			}
			if len(visits.writes) != 0 {
				t.Fatalf("refused completion must not write statuses, got %d", len(visits.writes))
			}
		})
	}
}

// TestCompleteVisit_BranchIsolationAndSuperAdminBypass pins both sides of the
// branch rule: an admin locked to another branch is refused, while a
// superadmin without a location bypasses the branch like gate check-out.
func TestCompleteVisit_BranchIsolationAndSuperAdminBypass(t *testing.T) {
	t.Parallel()
	start, end := openWindow()
	newVisit := func() domain.VisitRequest {
		v := visitFixture("visit-complete-branch", domain.VisitStatusVisiting, start, end)
		v.LocationID = "loc-B"
		return v
	}
	t.Run("admin on another branch is forbidden", func(t *testing.T) {
		t.Parallel()
		visit := newVisit()
		visits := newFakeVisitRepo(visit)
		svc := checkInService(visits, newFakeCheckInOutRepo())
		actor := gate.Actor{ID: "adm-1", Role: domain.RoleAdmin, LocationID: uuidPtr("loc-A")}
		// When: a loc-A admin completes a loc-B permit.
		err := svc.CompleteVisit(t.Context(), actor, visit.ID)
		// Then: branch refusal, zero writes.
		if !errors.Is(err, domain.ErrForbiddenBranch) {
			t.Fatalf("expected ErrForbiddenBranch, got %v", err)
		}
		if len(visits.writes) != 0 {
			t.Fatalf("refused completion must not write statuses, got %d", len(visits.writes))
		}
	})
	t.Run("superadmin bypasses branch", func(t *testing.T) {
		t.Parallel()
		visit := newVisit()
		visits := newFakeVisitRepo(visit)
		svc := checkInService(visits, newFakeCheckInOutRepo())
		actor := gate.Actor{ID: "su-1", Role: domain.RoleSuperAdmin}
		// When: a superadmin without a location completes a loc-B permit.
		err := svc.CompleteVisit(t.Context(), actor, visit.ID)
		// Then: bypass succeeds.
		if err != nil {
			t.Fatalf("expected superadmin bypass to succeed, got %v", err)
		}
		if visits.visits[visit.ID].Status != domain.VisitStatusCompleted {
			t.Fatalf("expected status completed, got %q", visits.visits[visit.ID].Status)
		}
	})
}

// TestCompleteVisit_MissingVisitReturnsNotFound pins the resolve-first guard.
func TestCompleteVisit_MissingVisitReturnsNotFound(t *testing.T) {
	t.Parallel()
	visits := newFakeVisitRepo()
	svc := checkInService(visits, newFakeCheckInOutRepo())
	actor := gate.Actor{ID: "adm-1", Role: domain.RoleAdmin, LocationID: uuidPtr("loc-A")}
	// When: completion targets an unknown id.
	err := svc.CompleteVisit(t.Context(), actor, "visit-ghost")
	// Then: NotFoundEntity("Kunjungan").
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}
