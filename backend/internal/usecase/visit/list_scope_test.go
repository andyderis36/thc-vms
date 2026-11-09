package visit

import (
	"context"
	"errors"
	"testing"

	"thc-vms/backend/internal/domain"
)

// recording returns a service plus the fake repository behind it, so a test can
// assert the exact domain.VisitFilter the usecase built.
func recording(t *testing.T) (*Service, *fakeVisitRepo) {
	t.Helper()
	repo := newFakeVisitRepo(t)
	return newTestService(repo, nil, testNow()), repo
}

// Given a super_admin, when it narrows the listing by branch, then the filter
// must reach the repository. The parameter is documented (openapi L264-267,
// PRD L109, QA_CHECKLIST AUTH-05) and was once dropped on the floor: the input
// struct had no field for it, so every filter silently returned every row.
func TestListVisits_SuperAdminCanNarrowByLocation(t *testing.T) {
	svc, repo := recording(t)
	branch := domain.UUID("11111111-1111-4111-8111-111111111111")

	_, _, err := svc.ListVisits(context.Background(),
		testActor(domain.RoleSuperAdmin, "sa", ""),
		ListVisitsInput{LocationID: &branch})
	if err != nil {
		t.Fatalf("super_admin narrowing must succeed: %v", err)
	}

	if len(repo.lastFilter.LocationIDs) != 1 || repo.lastFilter.LocationIDs[0] != branch {
		t.Fatalf("LocationIDs = %v, want the requested branch %q", repo.lastFilter.LocationIDs, branch)
	}
	if repo.lastFilter.IsGlobal {
		t.Fatal("a narrowed super_admin listing must not stay global")
	}
	if repo.lastFilter.VendorUserID != nil {
		t.Fatal("a location filter must never introduce a vendor scope")
	}
}

// Without the filter, super_admin keeps global scope.
func TestListVisits_SuperAdminWithoutFilterIsGlobal(t *testing.T) {
	svc, repo := recording(t)

	if _, _, err := svc.ListVisits(context.Background(),
		testActor(domain.RoleSuperAdmin, "sa", ""), ListVisitsInput{}); err != nil {
		t.Fatalf("super_admin global listing must succeed: %v", err)
	}
	if !repo.lastFilter.IsGlobal || len(repo.lastFilter.LocationIDs) != 0 || repo.lastFilter.VendorUserID != nil {
		t.Fatalf("an unfiltered super_admin listing must carry global scope, got %+v", repo.lastFilter)
	}
}

// SECURITY-CRITICAL: a branch-locked role that passes another branch's
// location_id is refused with the 403 FORBIDDEN_BRANCH sentinel and no
// repository query. A query parameter may narrow inside the caller's scope,
// never widen it and never pass silently.
func TestListVisits_AdminCannotWidenScopeWithAForeignLocation(t *testing.T) {
	ownBranch := domain.UUID("22222222-2222-4222-8222-222222222222")
	foreignBranch := domain.UUID("33333333-3333-4333-8333-333333333333")

	for _, role := range []domain.RoleName{domain.RoleAdmin, domain.RoleSecurity} {
		t.Run(string(role), func(t *testing.T) {
			svc, repo := recording(t)

			_, _, err := svc.ListVisits(context.Background(),
				testActor(role, "u1", string(ownBranch)),
				ListVisitsInput{LocationID: &foreignBranch})
			if !errors.Is(err, domain.ErrForbiddenBranch) {
				t.Fatalf("err = %v, want the FORBIDDEN_BRANCH 403 sentinel", err)
			}
			if repo.listCalls != 0 {
				t.Fatalf("a refused listing must never reach the repository, got %d List calls", repo.listCalls)
			}
		})
	}
}

// A vendor stays pinned to its own visits even when it names a branch.
func TestListVisits_VendorCannotEscapeItsOwnVisits(t *testing.T) {
	svc, repo := recording(t)
	branch := domain.UUID("44444444-4444-4444-8444-444444444444")

	if _, _, err := svc.ListVisits(context.Background(),
		testActor(domain.RoleVendor, "vendor-1", ""),
		ListVisitsInput{LocationID: &branch}); err != nil {
		t.Fatalf("listing must succeed: %v", err)
	}
	if repo.lastFilter.VendorUserID == nil || *repo.lastFilter.VendorUserID != domain.UUID("vendor-1") {
		t.Fatalf("VisitFilter.VendorUserID = %v, want the actor's own id", repo.lastFilter.VendorUserID)
	}
	if len(repo.lastFilter.LocationIDs) != 0 {
		t.Fatalf("a vendor listing must carry no branch scope, got %v", repo.lastFilter.LocationIDs)
	}
	if repo.lastFilter.IsGlobal {
		t.Fatal("a vendor listing must never be global")
	}
}

// An unrecognised role is still refused outright.
func TestListVisits_UnknownRoleIsRefused(t *testing.T) {
	svc, _ := recording(t)
	if _, _, err := svc.ListVisits(context.Background(),
		testActor(domain.RoleName("auditor"), "x", ""), ListVisitsInput{}); err == nil {
		t.Fatal("an unknown role must be refused, not silently granted global scope")
	}
}
