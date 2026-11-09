package visit

import (
	"context"
	"errors"
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
)

// Union membership matrix for the lifecycle edges: an admin covering A+B
// acts on visits at A and B (even when the scalar primary is A and the visit
// sits at B), while a visit at C is refused with 403 and zero repository
// writes. The branch guard is already union-aware, so these tests pin the
// wired behaviour; the listing tests beside them are the RED half.

func seedVisitAt(repo *fakeVisitRepo, id, code, branch string, status domain.VisitStatus) domain.VisitRequest {
	visit := domain.VisitRequest{
		ID:            domain.UUID(id),
		VisitID:       code,
		VendorUserID:  domain.UUID("vendor-1"),
		LocationID:    domain.UUID(branch),
		StartDate:     time.Date(2026, time.October, 1, 9, 0, 0, 0, time.UTC),
		EndDate:       time.Date(2026, time.October, 1, 17, 0, 0, 0, time.UTC),
		Status:        status,
		IsNDAAccepted: true,
	}
	seedVisit(repo, visit)
	return visit
}

func TestLifecycle_UnionMemberActsOnCoveredBranches(t *testing.T) {
	t.Parallel()
	// Given: an admin whose scalar primary is A but whose union covers A+B.
	actor := unionActor(domain.RoleAdmin, "admin-1", "loc-A", "loc-A", "loc-B")

	// Approve on B must succeed despite the scalar mismatch.
	repo := newFakeVisitRepo(t)
	seedVisitAt(repo, "visit-b", "VST-0000000091", "loc-B", domain.VisitStatusRequested)
	svc := newTestService(repo, nil, testNow())
	if err := svc.Approve(context.Background(), actor, domain.UUID("visit-b"), "disetujui"); err != nil {
		t.Fatalf("union-member approve on B refused: %v", err)
	}

	// Reschedule on B must succeed.
	repo = newFakeVisitRepo(t)
	seedVisitAt(repo, "visit-b", "VST-0000000091", "loc-B", domain.VisitStatusApproved)
	svc = newTestService(repo, nil, testNow())
	start := time.Date(2026, time.October, 7, 9, 0, 0, 0, time.UTC)
	end := time.Date(2026, time.October, 7, 17, 0, 0, 0, time.UTC)
	if err := svc.Reschedule(context.Background(), actor, domain.UUID("visit-b"), start, end, "jadwal berubah"); err != nil {
		t.Fatalf("union-member reschedule on B refused: %v", err)
	}

	// Cancel on A must succeed.
	repo = newFakeVisitRepo(t)
	seedVisitAt(repo, "visit-a", "VST-0000000092", "loc-A", domain.VisitStatusRequested)
	svc = newTestService(repo, nil, testNow())
	if err := svc.Cancel(context.Background(), actor, domain.UUID("visit-a"), "batal"); err != nil {
		t.Fatalf("union-member cancel on A refused: %v", err)
	}
}

func TestLifecycle_UnionNonMemberRefusedOnC(t *testing.T) {
	t.Parallel()
	// Given: the same A+B admin against a visit at C.
	actor := unionActor(domain.RoleAdmin, "admin-1", "loc-A", "loc-A", "loc-B")
	ctx := context.Background()

	repo := newFakeVisitRepo(t)
	seedVisitAt(repo, "visit-c1", "VST-0000000093", "loc-C", domain.VisitStatusRequested)
	seedVisitAt(repo, "visit-c2", "VST-0000000094", "loc-C", domain.VisitStatusApproved)
	seedVisitAt(repo, "visit-c3", "VST-0000000095", "loc-C", domain.VisitStatusRequested)
	svc := newTestService(repo, nil, testNow())

	start := time.Date(2026, time.October, 7, 9, 0, 0, 0, time.UTC)
	end := time.Date(2026, time.October, 7, 17, 0, 0, 0, time.UTC)
	cases := []struct {
		name string
		call func() error
	}{
		{"approve on C", func() error { return svc.Approve(ctx, actor, domain.UUID("visit-c1"), "coba") }},
		{"reschedule on C", func() error {
			return svc.Reschedule(ctx, actor, domain.UUID("visit-c2"), start, end, "jadwal berubah")
		}},
		{"cancel on C", func() error { return svc.Cancel(ctx, actor, domain.UUID("visit-c3"), "batal") }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if err := tc.call(); !errors.Is(err, domain.ErrForbiddenBranch) {
				t.Fatalf("error = %v, want ErrForbiddenBranch", err)
			}
		})
	}
	if repo.writes != 0 {
		t.Fatalf("refused edges caused %d repository writes, want 0", repo.writes)
	}
}
