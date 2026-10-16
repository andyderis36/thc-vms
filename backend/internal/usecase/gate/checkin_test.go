package gate_test

import (
	"errors"
	"strings"
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/gate"
)

// exactBranchMessage is the mandated 403 text for cross-branch refusals.
const exactBranchMessage = "Tidak berhak mengelola kunjungan cabang lain"

func checkInService(visits *fakeVisitRepo, checks *fakeCheckInOutRepo) *gate.Service {
	return gate.NewService(gate.Dependencies{
		Visits:   visits,
		CheckIns: checks,
		Clock:    &stubClock{now: fixedNow},
	})
}

func TestCheckIn_VendorIsForbidden(t *testing.T) {
	t.Parallel()
	// Given: an approved in-window visit and a PIC actor.
	start, end := openWindow()
	visit := visitFixture("visit-pic", domain.VisitStatusApproved, start, end)
	visits := newFakeVisitRepo(visit)
	checks := newFakeCheckInOutRepo()
	svc := checkInService(visits, checks)
	actor := gate.Actor{ID: "pic-1", Role: domain.RoleVendor}
	// When: the external PIC tries to check in.
	_, err := svc.CheckIn(t.Context(), actor, string(visit.ID), gate.CheckInInput{})
	// Then: refused as a branch violation with zero writes.
	if err == nil {
		t.Fatal("expected PIC check-in to be forbidden, got nil")
	}
	if !errors.Is(err, domain.ErrForbiddenBranch) {
		t.Fatalf("expected ErrForbiddenBranch, got %v", err)
	}
	if len(visits.writes) != 0 || len(checks.checkIns) != 0 {
		t.Fatalf("forbidden check-in must not write: %d status writes, %d check-ins",
			len(visits.writes), len(checks.checkIns))
	}
}

func TestCheckIn_SecurityOnAnotherBranchIsForbiddenWithTheMandatedMessage(t *testing.T) {
	t.Parallel()
	// Given: security of loc-A scanning a loc-B visit whose window is ALSO
	// closed, so only the mandated guard ORDER (branch before window) yields
	// the branch message.
	visit := visitFixture("visit-xbranch", domain.VisitStatusApproved,
		fixedNow.Add(10*time.Hour-0), fixedNow.Add(12*time.Hour))
	visit.LocationID = "loc-B"
	visits := newFakeVisitRepo(visit)
	checks := newFakeCheckInOutRepo()
	svc := checkInService(visits, checks)
	actor := gate.Actor{ID: "sec-1", Role: domain.RoleSecurity, LocationID: uuidPtr("loc-A")}
	// When: branch-locked security scans another branch (QA GATE-08).
	_, err := svc.CheckIn(t.Context(), actor, string(visit.ID), gate.CheckInInput{})
	// Then: exact 403 message AND zero repository writes.
	if err == nil {
		t.Fatal("expected cross-branch check-in to be forbidden, got nil")
	}
	if !errors.Is(err, domain.ErrForbiddenBranch) {
		t.Fatalf("expected ErrForbiddenBranch, got %v", err)
	}
	if !strings.Contains(err.Error(), exactBranchMessage) {
		t.Fatalf("expected mandated message %q, got %q", exactBranchMessage, err.Error())
	}
	if len(visits.writes) != 0 {
		t.Fatalf("refused check-in must not write statuses, got %d writes", len(visits.writes))
	}
	if len(checks.checkIns) != 0 {
		t.Fatalf("refused check-in must not record check-ins, got %d records", len(checks.checkIns))
	}
}

func TestCheckIn_SuperAdminBypassesBranch(t *testing.T) {
	t.Parallel()
	// Given: a super_admin with no location scanning a loc-B visit in-window.
	start, end := openWindow()
	visit := visitFixture("visit-su", domain.VisitStatusApproved, start, end)
	visit.LocationID = "loc-B"
	visits := newFakeVisitRepo(visit)
	checks := newFakeCheckInOutRepo()
	svc := checkInService(visits, checks)
	actor := gate.Actor{ID: "su-1", Role: domain.RoleSuperAdmin}
	// When: check-in runs via the VST- code path.
	got, err := svc.CheckIn(t.Context(), actor, visit.VisitID, gate.CheckInInput{})
	// Then: the bypass matrix cell holds — check-in succeeds.
	if err != nil {
		t.Fatalf("expected super_admin bypass to succeed, got %v", err)
	}
	if got.VisitRequestID != visit.ID {
		t.Fatalf("expected check-in for %q, got %q", visit.ID, got.VisitRequestID)
	}
	if visits.visits[visit.ID].Status != domain.VisitStatusVisiting {
		t.Fatalf("expected status visiting, got %q", visits.visits[visit.ID].Status)
	}
}

func TestCheckIn_RefusesRescheduledVisitUntilReapproved(t *testing.T) {
	t.Parallel()
	// Given: a rescheduled visit (in-window, own branch) — the state-machine
	// trap, since rescheduled->visiting is forbidden by omission.
	start, end := openWindow()
	visit := visitFixture("visit-resched", domain.VisitStatusRescheduled, start, end)
	visits := newFakeVisitRepo(visit)
	checks := newFakeCheckInOutRepo()
	svc := checkInService(visits, checks)
	actor := gate.Actor{ID: "sec-1", Role: domain.RoleSecurity, LocationID: uuidPtr("loc-A")}
	// When: check-in runs before re-approval.
	_, err := svc.CheckIn(t.Context(), actor, string(visit.ID), gate.CheckInInput{})
	// Then: conflict with the re-approval demand, and the visit keeps its
	// rescheduled status.
	if err == nil {
		t.Fatal("expected rescheduled check-in to be refused, got nil")
	}
	if !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("expected ErrConflict, got %v", err)
	}
	if !strings.Contains(err.Error(), "harus disetujui kembali") {
		t.Fatalf("expected re-approval message, got %q", err.Error())
	}
	if len(visits.writes) != 0 || len(checks.checkIns) != 0 {
		t.Fatalf("refused check-in must not write: %d status writes, %d check-ins",
			len(visits.writes), len(checks.checkIns))
	}
}

func TestCheckIn_RefusesNonApprovedStates(t *testing.T) {
	t.Parallel()
	// Given: every non-approved status, each in-window on the actor's branch.
	statuses := []domain.VisitStatus{
		domain.VisitStatusRequested,
		domain.VisitStatusVisiting,
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
			visit := visitFixture(domain.UUID("visit-"+status), status, start, end)
			visits := newFakeVisitRepo(visit)
			checks := newFakeCheckInOutRepo()
			svc := checkInService(visits, checks)
			actor := gate.Actor{ID: "adm-1", Role: domain.RoleAdmin, LocationID: uuidPtr("loc-A")}
			// When: check-in runs against a non-approved state.
			_, err := svc.CheckIn(t.Context(), actor, string(visit.ID), gate.CheckInInput{})
			// Then: only approved may check in.
			if err == nil {
				t.Fatalf("expected status %q to refuse check-in, got nil", status)
			}
			if !errors.Is(err, domain.ErrConflict) {
				t.Fatalf("expected ErrConflict for status %q, got %v", status, err)
			}
		})
	}
}

func TestCheckIn_PhotoIsOptional(t *testing.T) {
	t.Parallel()
	// Given: an approved in-window visit; the flow diagram has no photo step.
	start, end := openWindow()
	visit := visitFixture("visit-nophoto", domain.VisitStatusApproved, start, end)
	visits := newFakeVisitRepo(visit)
	checks := newFakeCheckInOutRepo()
	svc := checkInService(visits, checks)
	actor := gate.Actor{ID: "sec-1", Role: domain.RoleSecurity, LocationID: uuidPtr("loc-A")}
	// When: check-in runs with no photo, no badge, no notes.
	got, err := svc.CheckIn(t.Context(), actor, string(visit.ID), gate.CheckInInput{})
	// Then: success with empty optionals preserved.
	if err != nil {
		t.Fatalf("expected photo-less check-in to succeed, got %v", err)
	}
	if got.PhotoURL != nil {
		t.Fatalf("expected nil photo URL, got %q", *got.PhotoURL)
	}
	if got.BadgeCode != nil {
		t.Fatalf("expected nil badge code, got %q", *got.BadgeCode)
	}
	if got.CheckedInBy != actor.ID {
		t.Fatalf("expected checked-in by %q, got %q", actor.ID, got.CheckedInBy)
	}
}

func TestCheckIn_DoubleCheckInReturnsConflict(t *testing.T) {
	t.Parallel()
	// Given: an approved in-window visit that already has a check-in row
	// (UNIQUE on check_in.visit_request_id).
	start, end := openWindow()
	visit := visitFixture("visit-double", domain.VisitStatusApproved, start, end)
	visits := newFakeVisitRepo(visit)
	checks := newFakeCheckInOutRepo()
	checks.checkIns[visit.ID] = domain.CheckIn{
		ID:             "checkin-visit-double",
		VisitRequestID: visit.ID,
		CheckedInAt:    fixedNow.Add(-time.Minute),
		CheckedInBy:    "sec-1",
	}
	svc := checkInService(visits, checks)
	actor := gate.Actor{ID: "sec-1", Role: domain.RoleSecurity, LocationID: uuidPtr("loc-A")}
	// When: a second check-in runs.
	_, err := svc.CheckIn(t.Context(), actor, string(visit.ID), gate.CheckInInput{})
	// Then: the uniqueness clash surfaces as a conflict.
	if err == nil {
		t.Fatal("expected double check-in to conflict, got nil")
	}
	if !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("expected ErrConflict, got %v", err)
	}
}

func TestCheckIn_MissingVisitReturnsNotFound(t *testing.T) {
	t.Parallel()
	// Given: an empty repository.
	visits := newFakeVisitRepo()
	checks := newFakeCheckInOutRepo()
	svc := checkInService(visits, checks)
	actor := gate.Actor{ID: "sec-1", Role: domain.RoleSecurity, LocationID: uuidPtr("loc-A")}
	// When: check-in targets an unknown id and an unknown VST- code.
	for _, target := range []string{"visit-ghost", "VST-GHOST00001"} {
		_, err := svc.CheckIn(t.Context(), actor, target, gate.CheckInInput{})
		// Then: NotFoundEntity("Kunjungan").
		if err == nil {
			t.Fatalf("expected not-found for %q, got nil", target)
		}
		if !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("expected ErrNotFound for %q, got %v", target, err)
		}
	}
}
