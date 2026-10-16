package visit

import (
	"context"
	"errors"
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
)

func seedApprovedVisit(repo *fakeVisitRepo) domain.VisitRequest {
	visit := domain.VisitRequest{
		ID:            domain.UUID("visit-10"),
		VisitID:       "VST-0000000010",
		PICUserID:     domain.UUID("pic-1"),
		LocationID:    domain.UUID("loc-A"),
		StartDate:     time.Date(2026, time.October, 5, 9, 0, 0, 0, time.UTC),
		EndDate:       time.Date(2026, time.October, 5, 17, 0, 0, 0, time.UTC),
		Status:        domain.VisitStatusApproved,
		IsNDAAccepted: true,
	}
	seedVisit(repo, visit)
	return visit
}

func TestReschedule_SetsRescheduledAndNotVisiting(t *testing.T) {
	repo := newFakeVisitRepo(t)
	seedApprovedVisit(repo)
	svc := newTestService(repo, nil, testNow())
	actor := testActor(domain.RoleAdmin, "admin-1", "loc-A")

	start := time.Date(2026, time.October, 7, 9, 0, 0, 0, time.UTC)
	end := time.Date(2026, time.October, 7, 17, 0, 0, 0, time.UTC)
	if err := svc.Reschedule(context.Background(), actor, domain.UUID("visit-10"), start, end, "jadwal teknisi berubah"); err != nil {
		t.Fatalf("Reschedule returned error: %v", err)
	}
	if len(repo.rescheduleCalls) != 1 {
		t.Fatalf("rescheduleCalls = %d, want 1", len(repo.rescheduleCalls))
	}
	call := repo.rescheduleCalls[0]
	if !call.start.Equal(start) || !call.end.Equal(end) {
		t.Errorf("reschedule window = %v..%v, want %v..%v", call.start, call.end, start, end)
	}
	if call.reason != "jadwal teknisi berubah" {
		t.Errorf("reason = %q, want it stored as the history note", call.reason)
	}
	if len(repo.updateCalls) != 0 {
		t.Errorf("updateCalls = %d, want 0: reschedule must not write a status update", len(repo.updateCalls))
	}
	stored, err := repo.FindByID(context.Background(), domain.UUID("visit-10"))
	if err != nil {
		t.Fatalf("FindByID returned error: %v", err)
	}
	if stored.Status != domain.VisitStatusRescheduled {
		t.Errorf("stored status = %q, want rescheduled", stored.Status)
	}
	if stored.Status == domain.VisitStatusVisiting {
		t.Error("stored status is visiting: a rescheduled visit must never land in visiting")
	}
}

func TestReschedule_AllowsOnlyRequestedApprovedRescheduledSources(t *testing.T) {
	// Given: one visit in each of the 8 lifecycle states.
	// When:  the branch admin reschedules it.
	// Then:  only requested, approved and rescheduled are accepted; the other
	//        five are refused with ErrInvalidTransition and zero writes.
	allowed := map[domain.VisitStatus]bool{
		domain.VisitStatusRequested:   true,
		domain.VisitStatusApproved:    true,
		domain.VisitStatusRescheduled: true,
	}
	start := time.Date(2026, time.October, 7, 9, 0, 0, 0, time.UTC)
	end := time.Date(2026, time.October, 7, 17, 0, 0, 0, time.UTC)
	for _, status := range domain.AllVisitStatuses() {
		t.Run(string(status), func(t *testing.T) {
			repo := newFakeVisitRepo(t)
			visit := domain.VisitRequest{
				ID:            domain.UUID("visit-src"),
				VisitID:       "VST-0000000099",
				PICUserID:     domain.UUID("pic-1"),
				LocationID:    domain.UUID("loc-A"),
				StartDate:     start,
				EndDate:       end,
				Status:        status,
				IsNDAAccepted: true,
			}
			seedVisit(repo, visit)
			svc := newTestService(repo, nil, testNow())
			actor := testActor(domain.RoleAdmin, "admin-1", "loc-A")

			err := svc.Reschedule(context.Background(), actor, visit.ID, start, end, "jadwal teknisi berubah")

			if allowed[status] {
				if err != nil {
					t.Fatalf("Reschedule from %q = %v, want nil", status, err)
				}
				if len(repo.rescheduleCalls) != 1 {
					t.Fatalf("rescheduleCalls = %d, want 1", len(repo.rescheduleCalls))
				}
				return
			}
			if !errors.Is(err, domain.ErrInvalidTransition) {
				t.Fatalf("Reschedule from %q = %v, want ErrInvalidTransition", status, err)
			}
			if repo.writes != 0 {
				t.Errorf("writes = %d, want 0 on refused source %q", repo.writes, status)
			}
		})
	}
}

func TestReschedule_RejectsBadWindowAndMissingReason(t *testing.T) {
	repo := newFakeVisitRepo(t)
	seedApprovedVisit(repo)
	svc := newTestService(repo, nil, testNow())
	actor := testActor(domain.RoleAdmin, "admin-1", "loc-A")

	start := time.Date(2026, time.October, 7, 9, 0, 0, 0, time.UTC)
	end := time.Date(2026, time.October, 7, 17, 0, 0, 0, time.UTC)
	if err := svc.Reschedule(context.Background(), actor, domain.UUID("visit-10"), end, start, "alasan"); err == nil {
		t.Error("reversed window must be rejected, got nil error")
	} else if !errors.Is(err, domain.ErrValidation) {
		t.Errorf("reversed window error = %v, want validation failure", err)
	}
	if err := svc.Reschedule(context.Background(), actor, domain.UUID("visit-10"), start, end, "  "); err == nil {
		t.Error("missing reason must be rejected, got nil error")
	} else if !errors.Is(err, domain.ErrValidation) {
		t.Errorf("missing reason error = %v, want validation failure", err)
	}
	if repo.writes != 0 {
		t.Errorf("writes = %d, want 0", repo.writes)
	}
}
