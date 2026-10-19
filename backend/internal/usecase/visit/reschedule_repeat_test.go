package visit

import (
	"context"
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
)

// TestReschedule_SecondRescheduleNeedsNoReapproval reproduces the VST-9801185741
// report: moving the schedule a second time used to fail CanTransition with a
// 409 ("Transisi status kunjungan tidak diizinkan.") because the rescheduled
// state had no self edge. Moving the schedule again needs no re-approval, so
// the second reschedule lands in rescheduled again with zero approve call.
// (Check-in afterwards still needs re-approval: rescheduled->visiting stays
// forbidden.)
func TestReschedule_SecondRescheduleNeedsNoReapproval(t *testing.T) {
	repo := newFakeVisitRepo(t)
	seedApprovedVisit(repo)
	svc := newTestService(repo, nil, testNow())
	actor := testActor(domain.RoleVendor, "vendor-1", "")

	firstStart := time.Date(2026, time.October, 7, 9, 0, 0, 0, time.UTC)
	firstEnd := time.Date(2026, time.October, 7, 17, 0, 0, 0, time.UTC)
	// Given: an approved visit moved once — no admin approve call anywhere.
	// When:  the vendor moves the schedule, then moves it again.
	if err := svc.Reschedule(context.Background(), actor, domain.UUID("visit-10"), firstStart, firstEnd, "jadwal teknisi berubah"); err != nil {
		t.Fatalf("first Reschedule returned error: %v", err)
	}
	secondStart := time.Date(2026, time.October, 9, 9, 0, 0, 0, time.UTC)
	secondEnd := time.Date(2026, time.October, 9, 17, 0, 0, 0, time.UTC)
	if err := svc.Reschedule(context.Background(), actor, domain.UUID("visit-10"), secondStart, secondEnd, "genset belum datang"); err != nil {
		t.Fatalf("second Reschedule returned error: %v", err)
	}
	// Then: both reschedules land, the visit stays rescheduled on the newest
	// window, and no status-update write (approve) ever happens.
	if len(repo.rescheduleCalls) != 2 {
		t.Fatalf("rescheduleCalls = %d, want 2", len(repo.rescheduleCalls))
	}
	if len(repo.updateCalls) != 0 {
		t.Fatalf("updateCalls = %d, want 0: rescheduling twice must not need re-approval", len(repo.updateCalls))
	}
	stored, err := repo.FindByID(context.Background(), domain.UUID("visit-10"))
	if err != nil {
		t.Fatalf("FindByID returned error: %v", err)
	}
	if stored.Status != domain.VisitStatusRescheduled {
		t.Errorf("stored status = %q, want rescheduled", stored.Status)
	}
	if !stored.StartDate.Equal(secondStart) || !stored.EndDate.Equal(secondEnd) {
		t.Errorf("stored window = %v..%v, want %v..%v", stored.StartDate, stored.EndDate, secondStart, secondEnd)
	}
}
