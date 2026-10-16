package worker_test

// TDD (S1 N+1 kill on the R2 path): sweepNoShow must resolve check-in
// existence for all candidates with ONE batched lookup, never one
// FindCheckInByVisit probe per visit.

import (
	"context"
	"fmt"
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/worker"
)

// batchCheckInFake serves domain.CheckInOutRepository and the optional
// worker.CheckInBatchProber, counting each seam separately so the test can
// prove the batch seam carried the whole sweep.
type batchCheckInFake struct {
	present     map[domain.UUID]bool
	batchCalls  int
	singleCalls int
}

func (f *batchCheckInFake) RecordCheckIn(_ context.Context, in domain.CheckIn) (domain.CheckIn, error) {
	if f.present[in.VisitRequestID] {
		return domain.CheckIn{}, fmt.Errorf("batchCheckInFake: duplicate: %w", domain.ErrConflict)
	}
	if f.present == nil {
		f.present = make(map[domain.UUID]bool)
	}
	f.present[in.VisitRequestID] = true
	return in, nil
}

func (f *batchCheckInFake) RecordCheckOut(_ context.Context, in domain.CheckOut) (domain.CheckOut, error) {
	return in, nil
}

func (f *batchCheckInFake) FindCheckInByVisit(_ context.Context, visitID domain.UUID) (domain.CheckIn, error) {
	f.singleCalls++
	if f.present[visitID] {
		return domain.CheckIn{VisitRequestID: visitID}, nil
	}
	return domain.CheckIn{}, fmt.Errorf("batchCheckInFake: missing: %w", domain.ErrNotFound)
}

func (f *batchCheckInFake) FindCheckOutByVisit(_ context.Context, _ domain.UUID) (domain.CheckOut, error) {
	return domain.CheckOut{}, fmt.Errorf("batchCheckInFake: missing: %w", domain.ErrNotFound)
}

// FindCheckInsByVisits answers existence for the whole sweep in one call.
func (f *batchCheckInFake) FindCheckInsByVisits(_ context.Context, ids []domain.UUID) (map[domain.UUID]bool, error) {
	f.batchCalls++
	out := make(map[domain.UUID]bool, len(ids))
	for _, id := range ids {
		if f.present[id] {
			out[id] = true
		}
	}
	return out, nil
}

// TestSweepNoShow_UsesOneBatchedCheckInLookup proves the R2 sweep issues ONE
// batched check-in lookup for N candidates and zero single probes, while
// still flipping the 3 true no-shows and skipping the checked-in visit.
func TestSweepNoShow_UsesOneBatchedCheckInLookup(t *testing.T) {
	t.Parallel()
	// Given: 4 approved candidates past the closed window; the first one has
	// a check-in row.
	candidates := make([]domain.VisitRequest, 0, 4)
	for i := 0; i < 4; i++ {
		candidates = append(candidates, mkVisit(
			domain.UUID(fmt.Sprintf("visit-batch-%d", i)),
			domain.VisitStatusApproved,
			workerNow.Add(-24*time.Hour),
			workerNow.Add(-5*time.Hour),
			workerNow.Add(-3*time.Hour),
		))
	}
	checks := &batchCheckInFake{present: map[domain.UUID]bool{candidates[0].ID: true}}
	visits := newFakeVisitRepo(candidates...)
	rules := &fakeAutoRules{noShow: candidates}
	svc := worker.NewService(worker.Dependencies{
		Visits:   visits,
		Rules:    rules,
		CheckIns: checks,
		Clock:    &stubClock{now: workerNow},
	})
	// When: the sweep runs.
	summary := svc.Run(context.Background())
	// Then: one batch lookup carried all 4 candidates, no single probe ran.
	if checks.batchCalls != 1 {
		t.Fatalf("R2 check-in lookup ran %d batch calls for 4 candidates, want 1 (RED: N probes)", checks.batchCalls)
	}
	if checks.singleCalls != 0 {
		t.Fatalf("R2 fell back to %d single probes, want 0", checks.singleCalls)
	}
	// And the outcomes are unchanged: 3 flipped, 1 skipped.
	if summary.NoShow != 3 {
		t.Fatalf("expected 3 no-shows, got %+v", summary)
	}
	if summary.Skipped != 1 {
		t.Fatalf("expected 1 skip (checked-in visit), got %+v", summary)
	}
	if len(summary.Failures) != 0 {
		t.Fatalf("expected no failures, got %+v", summary.Failures)
	}
}
