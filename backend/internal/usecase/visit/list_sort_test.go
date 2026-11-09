package visit

import (
	"context"
	"testing"

	"thc-vms/backend/internal/domain"
)

// RED proof: ListVisitsInput must carry SortBy/SortOrder through to the
// repository filter. Fails to COMPILE before the fix (no sort fields).
func TestListVisits_SortPassthroughRED(t *testing.T) {
	cases := []struct {
		name  string
		sort  string
		order string
	}{
		{"created_at desc", "created_at", "desc"},
		{"created_at asc", "created_at", "asc"},
		{"start_date desc", "start_date", "desc"},
		{"start_date asc", "start_date", "asc"},
		{"end_date desc", "end_date", "desc"},
		{"end_date asc", "end_date", "asc"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc, repo := recording(t)
			actor := testActor(domain.RoleSuperAdmin, "sa", "")
			in := ListVisitsInput{
				Page: 1, Limit: 10,
				SortBy: domain.VisitSortBy(tc.sort),
				Order:  domain.VisitSortOrder(tc.order),
			}
			if _, _, err := svc.ListVisits(context.Background(), actor, in); err != nil {
				t.Fatalf("ListVisits returned error: %v", err)
			}
			if string(repo.lastFilter.SortBy) != tc.sort {
				t.Fatalf("RED: SortBy=%q reached repo, want %q", repo.lastFilter.SortBy, tc.sort)
			}
			if string(repo.lastFilter.Order) != tc.order {
				t.Fatalf("RED: Order=%q reached repo, want %q", repo.lastFilter.Order, tc.order)
			}
		})
	}
}

// Empty sort keeps legacy behaviour: created_at desc.
func TestListVisits_EmptySortMeansDefault(t *testing.T) {
	svc, repo := recording(t)
	actor := testActor(domain.RoleSuperAdmin, "sa", "")
	if _, _, err := svc.ListVisits(context.Background(), actor, ListVisitsInput{Page: 1, Limit: 10}); err != nil {
		t.Fatalf("ListVisits returned error: %v", err)
	}
	if repo.lastFilter.SortBy != domain.VisitSortCreatedAt {
		t.Fatalf("SortBy=%q, want created_at (legacy default)", repo.lastFilter.SortBy)
	}
	if repo.lastFilter.Order != domain.VisitSortDesc {
		t.Fatalf("Order=%q, want desc (legacy default)", repo.lastFilter.Order)
	}
}

// Invalid sort can never reach SQL: the usecase normalises to the safe default.
func TestListVisits_InvalidSortNormalisedToDefault(t *testing.T) {
	svc, repo := recording(t)
	actor := testActor(domain.RoleSuperAdmin, "sa", "")
	in := ListVisitsInput{
		Page: 1, Limit: 10,
		SortBy: domain.VisitSortBy("visit_id; DROP TABLE visits"),
		Order:  domain.VisitSortOrder("sideways"),
	}
	if _, _, err := svc.ListVisits(context.Background(), actor, in); err != nil {
		t.Fatalf("ListVisits returned error: %v", err)
	}
	if repo.lastFilter.SortBy != domain.VisitSortCreatedAt {
		t.Fatalf("SortBy=%q, want created_at default (injection must not pass)", repo.lastFilter.SortBy)
	}
	if repo.lastFilter.Order != domain.VisitSortDesc {
		t.Fatalf("Order=%q, want desc default (injection must not pass)", repo.lastFilter.Order)
	}
}

// Sort narrows only: scope stays total while sorting.
func TestListVisits_SortKeepsScope(t *testing.T) {
	loc := domain.UUID("loc-A")
	svc, repo := recording(t)
	if _, _, err := svc.ListVisits(context.Background(),
		testActor(domain.RoleAdmin, "a1", string(loc)),
		ListVisitsInput{
			Page: 1, Limit: 10,
			SortBy: domain.VisitSortStartDate, Order: domain.VisitSortAsc,
		}); err != nil {
		t.Fatalf("ListVisits returned error: %v", err)
	}
	if len(repo.lastFilter.LocationIDs) != 1 || repo.lastFilter.LocationIDs[0] != loc {
		t.Fatalf("admin scope leaked while sorting: %+v", repo.lastFilter)
	}
	if repo.lastFilter.SortBy != domain.VisitSortStartDate || repo.lastFilter.Order != domain.VisitSortAsc {
		t.Fatalf("sort lost under scope: %+v", repo.lastFilter)
	}
}
