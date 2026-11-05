package gate_test

// No-direct-hook proof for the gate layer: CheckIn and CheckOut flow through
// the visit repository's UpdateStatus (which owns the single after-commit
// email), so the gate service itself must perform zero direct mailer sends
// even with a mailer wired. The repository suite proves UpdateStatus emits
// exactly one email per transition; these tests pin the gate half of that
// chain. The mailer is always the domain FakeMailer: no SMTP is dialled.

import (
	"strings"
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/gate"
)

func gateServiceWithMailer(visits *fakeVisitRepo, checks *fakeCheckInOutRepo, mailer domain.Mailer) *gate.Service {
	return gate.NewService(gate.Dependencies{
		Visits:   visits,
		CheckIns: checks,
		Clock:    &stubClock{now: fixedNow},
		Mailer:   mailer,
	})
}

// TestCheckIn_PerformsNoDirectEmailSend proves a successful gate check-in
// performs its single UpdateStatus write with zero direct mailer sends: the
// one check-in email is emitted downstream by the repository, not here.
func TestCheckIn_PerformsNoDirectEmailSend(t *testing.T) {
	t.Parallel()
	// Given: an approved in-window visit and a wired fake mailer.
	start, end := openWindow()
	visit := visitFixture("visit-nohook-in", domain.VisitStatusApproved, start, end)
	visits := newFakeVisitRepo(visit)
	checks := newFakeCheckInOutRepo()
	fake := &domain.FakeMailer{}
	svc := gateServiceWithMailer(visits, checks, fake)
	actor := gate.Actor{ID: "sec-1", Role: domain.RoleSecurity, LocationID: uuidPtr("loc-A")}
	// When: check-in succeeds.
	if _, err := svc.CheckIn(t.Context(), actor, string(visit.ID), gate.CheckInInput{}); err != nil {
		t.Fatalf("expected check-in to succeed, got %v", err)
	}
	// Then: exactly one status write reached visiting, and the gate sent zero emails.
	if len(visits.writes) != 1 || visits.writes[0].status != domain.VisitStatusVisiting {
		t.Fatalf("writes = %+v, want exactly one move to visiting", visits.writes)
	}
	if len(fake.Calls) != 0 {
		t.Fatalf("gate email calls = %d, want 0 (no separate hook)", len(fake.Calls))
	}
}

// TestCheckOut_PerformsNoDirectEmailSend proves a successful gate check-out
// performs its single UpdateStatus write with zero direct mailer sends.
func TestCheckOut_PerformsNoDirectEmailSend(t *testing.T) {
	t.Parallel()
	// Given: a visiting visit and a wired fake mailer.
	start, end := openWindow()
	visit := visitFixture("visit-nohook-out", domain.VisitStatusVisiting, start, end)
	visits := newFakeVisitRepo(visit)
	checks := newFakeCheckInOutRepo()
	fake := &domain.FakeMailer{}
	svc := gateServiceWithMailer(visits, checks, fake)
	actor := gate.Actor{ID: "sec-1", Role: domain.RoleSecurity, LocationID: uuidPtr("loc-A")}
	// When: check-out succeeds.
	if _, err := svc.CheckOut(t.Context(), actor, visit.ID); err != nil {
		t.Fatalf("expected check-out to succeed, got %v", err)
	}
	// Then: exactly one status write reached completed, and the gate sent zero emails.
	if len(visits.writes) != 1 || visits.writes[0].status != domain.VisitStatusCompleted {
		t.Fatalf("writes = %+v, want exactly one move to completed", visits.writes)
	}
	if len(fake.Calls) != 0 {
		t.Fatalf("gate email calls = %d, want 0 (no separate hook)", len(fake.Calls))
	}
}

// TestCheckIn_WindowStillGuardedBeforeAnySend proves a refused check-in
// (outside the tolerance window) writes nothing and sends nothing.
func TestCheckIn_WindowStillGuardedBeforeAnySend(t *testing.T) {
	t.Parallel()
	// Given: an approved visit whose window closed an hour ago (end+2h past).
	visit := visitFixture("visit-nohook-window", domain.VisitStatusApproved,
		fixedNow.Add(-4*time.Hour), fixedNow.Add(-3*time.Hour))
	visits := newFakeVisitRepo(visit)
	checks := newFakeCheckInOutRepo()
	fake := &domain.FakeMailer{}
	svc := gateServiceWithMailer(visits, checks, fake)
	actor := gate.Actor{ID: "sec-1", Role: domain.RoleSecurity, LocationID: uuidPtr("loc-A")}
	// When: check-in is refused by the window guard.
	_, err := svc.CheckIn(t.Context(), actor, string(visit.ID), gate.CheckInInput{})
	if err == nil {
		t.Fatal("expected an out-of-window check-in to be refused, got nil")
	}
	// Then: zero writes and zero sends.
	if len(visits.writes) != 0 {
		t.Fatalf("refused check-in wrote %d statuses, want 0", len(visits.writes))
	}
	if len(fake.Calls) != 0 {
		t.Fatalf("gate email calls = %d, want 0", len(fake.Calls))
	}
	if !strings.Contains(err.Error(), "batas") && !strings.Contains(err.Error(), "Check-in") {
		t.Fatalf("unexpected refusal message: %v", err)
	}
}
