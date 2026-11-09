package visit

import (
	"context"
	"testing"

	"thc-vms/backend/internal/domain"
)

// RED proof: ?q= must survive ListVisitsInput -> VisitFilter.
// Fails to COMPILE before the fix (no Search field): search is silently dropped.
func TestListVisits_SearchPassthroughRED(t *testing.T) {
	svc, repo := recording(t)
	actor := testActor(domain.RoleSuperAdmin, "sa", "")

	if _, _, err := svc.ListVisits(context.Background(), actor,
		ListVisitsInput{Search: "Budi", Page: 1, Limit: 10}); err != nil {
		t.Fatalf("ListVisits returned error: %v", err)
	}
	if repo.lastFilter.Search != "Budi" {
		t.Fatalf("RED: Search=%q reached repo, want %q (q diisi tapi tak terfilter)", repo.lastFilter.Search, "Budi")
	}
}

// Empty/absent q keeps legacy behaviour: no text predicate.
func TestListVisits_EmptySearchMeansAll(t *testing.T) {
	svc, repo := recording(t)
	actor := testActor(domain.RoleSuperAdmin, "sa", "")

	if _, _, err := svc.ListVisits(context.Background(), actor,
		ListVisitsInput{Page: 1, Limit: 10}); err != nil {
		t.Fatalf("ListVisits returned error: %v", err)
	}
	if repo.lastFilter.Search != "" {
		t.Fatalf("empty search must stay empty, got %q", repo.lastFilter.Search)
	}
}

// Scope stays total while searching: admin keeps its branch, vendor its own id.
func TestListVisits_SearchKeepsScope(t *testing.T) {
	loc := domain.UUID("loc-A")

	svc, repo := recording(t)
	if _, _, err := svc.ListVisits(context.Background(),
		testActor(domain.RoleAdmin, "a1", string(loc)),
		ListVisitsInput{Search: "VST-1", Page: 1, Limit: 10}); err != nil {
		t.Fatalf("ListVisits returned error: %v", err)
	}
	if repo.lastFilter.Search != "VST-1" {
		t.Fatalf("admin Search=%q, want %q", repo.lastFilter.Search, "VST-1")
	}
	if len(repo.lastFilter.LocationIDs) != 1 || repo.lastFilter.LocationIDs[0] != loc {
		t.Fatalf("admin scope leaked while searching: %+v", repo.lastFilter)
	}

	svc2, repo2 := recording(t)
	if _, _, err := svc2.ListVisits(context.Background(),
		testActor(domain.RoleVendor, "vendor-9", ""),
		ListVisitsInput{Search: "VST-1", Page: 1, Limit: 10}); err != nil {
		t.Fatalf("ListVisits returned error: %v", err)
	}
	if repo2.lastFilter.Search != "VST-1" {
		t.Fatalf("vendor Search=%q, want %q", repo2.lastFilter.Search, "VST-1")
	}
	if repo2.lastFilter.VendorUserID == nil || *repo2.lastFilter.VendorUserID != domain.UUID("vendor-9") {
		t.Fatalf("vendor scope leaked while searching: %+v", repo2.lastFilter)
	}
}
