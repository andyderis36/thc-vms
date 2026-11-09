package visit

import (
	"context"
	"errors"
	"testing"

	"thc-vms/backend/internal/domain"
)

// Union leak matrix for the visit listing: an admin/security actor whose
// stashed scope covers branches A+B must list the A-union-B view, never the
// scalar-primary-only view and never branch C. These tests are RED against
// the scalar dispatch (VisitFilter carries only LocationID): the union ids
// never reach the repository, so a dual-branch admin sees only its primary.

func unionActor(role domain.RoleName, id, primary string, branches ...string) Actor {
	actor := Actor{ID: domain.UUID(id), Role: role}
	if primary != "" {
		locationID := domain.UUID(primary)
		actor.LocationID = &locationID
	}
	for _, b := range branches {
		actor.Branches = append(actor.Branches, domain.UUID(b))
	}
	return actor
}

func unionSet(ids []domain.UUID) map[domain.UUID]bool {
	set := make(map[domain.UUID]bool, len(ids))
	for _, id := range ids {
		set[id] = true
	}
	return set
}

// An admin covering A+B must carry both ids to the repository with IsGlobal
// false: the scalar dispatch drops B, leaking a narrowed view.
func TestListVisits_UnionScopeCarriesBothBranches(t *testing.T) {
	t.Parallel()
	for _, role := range []domain.RoleName{domain.RoleAdmin, domain.RoleSecurity} {
		t.Run(string(role), func(t *testing.T) {
			t.Parallel()
			svc, repo := recording(t)

			_, _, err := svc.ListVisits(context.Background(),
				unionActor(role, "u1", "loc-A", "loc-A", "loc-B"),
				ListVisitsInput{})
			if err != nil {
				t.Fatalf("listing must succeed: %v", err)
			}
			got := unionSet(repo.lastFilter.LocationIDs)
			if !got[domain.UUID("loc-A")] || !got[domain.UUID("loc-B")] {
				t.Fatalf("LocationIDs = %v, want the A-union-B view (RED: union dropped B)", repo.lastFilter.LocationIDs)
			}
			if repo.lastFilter.IsGlobal {
				t.Fatal("a branch listing must never be global")
			}
		})
	}
}

// A caller-supplied branch OUTSIDE the union is refused with the 403
// FORBIDDEN_BRANCH sentinel and no repository query: the parameter may narrow
// inside the union, never widen it and never pass silently.
func TestListVisits_UnionScopeCannotBeWidenedToC(t *testing.T) {
	t.Parallel()
	for _, role := range []domain.RoleName{domain.RoleAdmin, domain.RoleSecurity} {
		t.Run(string(role), func(t *testing.T) {
			t.Parallel()
			svc, repo := recording(t)
			foreign := domain.UUID("loc-C")

			_, _, err := svc.ListVisits(context.Background(),
				unionActor(role, "u1", "loc-A", "loc-A", "loc-B"),
				ListVisitsInput{LocationID: &foreign})
			if !errors.Is(err, domain.ErrForbiddenBranch) {
				t.Fatalf("err = %v, want the FORBIDDEN_BRANCH 403 sentinel", err)
			}
			if repo.listCalls != 0 {
				t.Fatalf("a refused listing must never reach the repository, got %d List calls", repo.listCalls)
			}
		})
	}
}

// A caller-supplied branch INSIDE the union narrows the filter to exactly that
// one id with IsGlobal false, for admin and security alike.
func TestListVisits_UnionScopeNarrowsToRequestedMember(t *testing.T) {
	t.Parallel()
	for _, role := range []domain.RoleName{domain.RoleAdmin, domain.RoleSecurity} {
		t.Run(string(role), func(t *testing.T) {
			t.Parallel()
			svc, repo := recording(t)
			member := domain.UUID("loc-B")

			_, _, err := svc.ListVisits(context.Background(),
				unionActor(role, "u1", "loc-A", "loc-A", "loc-B"),
				ListVisitsInput{LocationID: &member})
			if err != nil {
				t.Fatalf("an in-scope narrowing must succeed: %v", err)
			}
			got := unionSet(repo.lastFilter.LocationIDs)
			if len(got) != 1 || !got[member] {
				t.Fatalf("LocationIDs = %v, want exactly [%s]", repo.lastFilter.LocationIDs, member)
			}
			if repo.lastFilter.IsGlobal {
				t.Fatal("a narrowed branch listing must never be global")
			}
			if repo.lastFilter.VendorUserID != nil {
				t.Fatal("a branch narrowing must never introduce a vendor scope")
			}
		})
	}
}

// A branch actor with no stash and no scalar primary fails closed: empty ids
// with IsGlobal false, never the unscoped global view.
func TestListVisits_UnionScopeWithoutCoverageFailsClosed(t *testing.T) {
	t.Parallel()
	svc, repo := recording(t)

	_, _, err := svc.ListVisits(context.Background(),
		Actor{ID: "adm-orphan", Role: domain.RoleAdmin},
		ListVisitsInput{})
	if err != nil {
		t.Fatalf("listing must succeed: %v", err)
	}
	if len(repo.lastFilter.LocationIDs) != 0 {
		t.Fatalf("LocationIDs = %v, want empty for an uncovered actor", repo.lastFilter.LocationIDs)
	}
	if repo.lastFilter.IsGlobal {
		t.Fatal("an uncovered branch actor must never list globally (RED: fail-open to all branches)")
	}
}

// super_admin keeps the national view through IsGlobal; the optional branch
// narrowing rides as a single-id union with IsGlobal false.
func TestListVisits_SuperAdminUnionGlobalAndNarrow(t *testing.T) {
	t.Parallel()
	svc, repo := recording(t)
	if _, _, err := svc.ListVisits(context.Background(),
		testActor(domain.RoleSuperAdmin, "sa", ""), ListVisitsInput{}); err != nil {
		t.Fatalf("super_admin global listing must succeed: %v", err)
	}
	if !repo.lastFilter.IsGlobal {
		t.Fatal("unfiltered super_admin listing must be global (RED: global flag dropped)")
	}

	branch := domain.UUID("loc-A")
	if _, _, err := svc.ListVisits(context.Background(),
		testActor(domain.RoleSuperAdmin, "sa", ""), ListVisitsInput{LocationID: &branch}); err != nil {
		t.Fatalf("super_admin narrowing must succeed: %v", err)
	}
	got := unionSet(repo.lastFilter.LocationIDs)
	if len(got) != 1 || !got[branch] {
		t.Fatalf("LocationIDs = %v, want exactly [%s]", repo.lastFilter.LocationIDs, branch)
	}
	if repo.lastFilter.IsGlobal {
		t.Fatal("a narrowed super_admin listing must not stay global")
	}
}
