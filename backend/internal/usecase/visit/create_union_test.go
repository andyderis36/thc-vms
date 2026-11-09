package visit

import (
	"context"
	"errors"
	"testing"

	"thc-vms/backend/internal/domain"
)

// Union scope matrix for the create edge: an admin covering A+B files requests
// at A and B (even when the scalar primary is A and the destination is B),
// while a destination at C is refused with 403 and zero repository writes.
// The branch guard is already union-aware, so these tests pin the wired
// behaviour the scalar-only test beside them cannot see.
func TestCreateVisit_UnionMemberCreatesOnCoveredBranches(t *testing.T) {
	t.Parallel()
	actor := unionActor(domain.RoleAdmin, "admin-1", "loc-A", "loc-A", "loc-B")
	for _, dest := range []string{"loc-A", "loc-B"} {
		repo := newFakeVisitRepo(t)
		svc := newTestService(repo, nil, testNow())
		in := validCreateInput()
		in.LocationID = domain.UUID(dest)
		if _, err := svc.CreateVisit(context.Background(), actor, in); err != nil {
			t.Fatalf("union-member create at %s refused: %v", dest, err)
		}
		if repo.createCalls != 1 {
			t.Fatalf("create at %s must write once, got %d", dest, repo.createCalls)
		}
	}
}

func TestCreateVisit_UnionNonMemberRefusedOutsideScope(t *testing.T) {
	t.Parallel()
	actor := unionActor(domain.RoleAdmin, "admin-1", "loc-A", "loc-A", "loc-B")
	repo := newFakeVisitRepo(t)
	svc := newTestService(repo, nil, testNow())
	in := validCreateInput()
	in.LocationID = domain.UUID("loc-C")
	if _, err := svc.CreateVisit(context.Background(), actor, in); !errors.Is(err, domain.ErrForbiddenBranch) {
		t.Fatalf("error = %v, want ErrForbiddenBranch", err)
	}
	if repo.createCalls != 0 {
		t.Fatalf("createCalls = %d, want 0", repo.createCalls)
	}
}
