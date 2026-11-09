package visit

import (
	"context"
	"errors"
	"testing"

	"thc-vms/backend/internal/domain"
)

// Union edges the lifecycle matrix beside this file does not pin: Reject
// carries the same branch guard but validates the reason BEFORE the guard,
// and GetVisit shares the read predicate with the file stream. An admin
// covering A+B must reject and read at B (scalar primary A), while C is
// refused with 403 and zero repository writes. The C-side reject case uses a
// valid reason so the refusal comes from the branch guard, not validation.

func TestReject_UnionMemberActsOnCoveredBranch(t *testing.T) {
	t.Parallel()
	actor := unionActor(domain.RoleAdmin, "admin-1", "loc-A", "loc-A", "loc-B")

	repo := newFakeVisitRepo(t)
	seedVisitAt(repo, "visit-rb", "VST-0000000096", "loc-B", domain.VisitStatusRequested)
	svc := newTestService(repo, nil, testNow())
	if err := svc.Reject(context.Background(), actor, domain.UUID("visit-rb"), "kapasitas penuh"); err != nil {
		t.Fatalf("union-member reject on B refused: %v", err)
	}
}

func TestReject_UnionNonMemberRefusedOnC(t *testing.T) {
	t.Parallel()
	actor := unionActor(domain.RoleAdmin, "admin-1", "loc-A", "loc-A", "loc-B")

	repo := newFakeVisitRepo(t)
	seedVisitAt(repo, "visit-rc", "VST-0000000097", "loc-C", domain.VisitStatusRequested)
	svc := newTestService(repo, nil, testNow())
	if err := svc.Reject(context.Background(), actor, domain.UUID("visit-rc"), "kapasitas penuh"); !errors.Is(err, domain.ErrForbiddenBranch) {
		t.Fatalf("error = %v, want ErrForbiddenBranch", err)
	}
	if repo.writes != 0 {
		t.Fatalf("refused reject caused %d repository writes, want 0", repo.writes)
	}
}

func TestGetVisit_UnionMemberReadsCoveredBranch(t *testing.T) {
	t.Parallel()
	actor := unionActor(domain.RoleAdmin, "admin-1", "loc-A", "loc-A", "loc-B")

	repo := newFakeVisitRepo(t)
	seedVisitAt(repo, "visit-gb", "VST-0000000098", "loc-B", domain.VisitStatusApproved)
	svc := newTestService(repo, nil, testNow())
	got, err := svc.GetVisit(context.Background(), actor, "visit-gb")
	if err != nil {
		t.Fatalf("union-member read on B refused: %v", err)
	}
	if got.LocationID != domain.UUID("loc-B") {
		t.Fatalf("LocationID = %v, want loc-B", got.LocationID)
	}
}

func TestGetVisit_UnionNonMemberRefusedOnC(t *testing.T) {
	t.Parallel()
	actor := unionActor(domain.RoleAdmin, "admin-1", "loc-A", "loc-A", "loc-B")

	repo := newFakeVisitRepo(t)
	seedVisitAt(repo, "visit-gc", "VST-0000000099", "loc-C", domain.VisitStatusApproved)
	svc := newTestService(repo, nil, testNow())
	if _, err := svc.GetVisit(context.Background(), actor, "visit-gc"); !errors.Is(err, domain.ErrForbiddenBranch) {
		t.Fatalf("error = %v, want ErrForbiddenBranch", err)
	}
}
