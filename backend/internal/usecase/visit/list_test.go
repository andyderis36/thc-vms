package visit

import (
	"context"
	"testing"

	"thc-vms/backend/internal/domain"
)

func TestListVisits_BuildsTheCorrectScopePerRole(t *testing.T) {
	locA := domain.UUID("loc-A")
	vendorID := domain.UUID("pic-1")

	cases := []struct {
		name         string
		actor        Actor
		wantLocation *domain.UUID
		wantVendor   *domain.UUID
	}{
		{"super_admin sees all", testActor(domain.RoleSuperAdmin, "super-1", ""), nil, nil},
		{"admin locked to branch", testActor(domain.RoleAdmin, "admin-1", "loc-A"), &locA, nil},
		{"security locked to branch", testActor(domain.RoleSecurity, "sec-1", "loc-A"), &locA, nil},
		{"vendor locked to own visits", testActor(domain.RoleVendor, "pic-1", ""), nil, &vendorID},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			repo := newFakeVisitRepo(t)
			svc := newTestService(repo, nil, testNow())
			in := ListVisitsInput{Page: 1, Limit: 10}

			if _, _, err := svc.ListVisits(context.Background(), tc.actor, in); err != nil {
				t.Fatalf("ListVisits returned error: %v", err)
			}
			got := repo.lastFilter
			if tc.wantLocation == nil {
				if got.LocationID != nil {
					t.Errorf("LocationID = %q, want nil", *got.LocationID)
				}
			} else {
				if got.LocationID == nil {
					t.Fatalf("LocationID = nil, want %q", *tc.wantLocation)
				}
				if *got.LocationID != *tc.wantLocation {
					t.Errorf("LocationID = %q, want %q", *got.LocationID, *tc.wantLocation)
				}
			}
			if tc.wantVendor == nil {
				if got.PICUserID != nil {
					t.Errorf("PICUserID = %q, want nil", *got.PICUserID)
				}
			} else {
				if got.PICUserID == nil {
					t.Fatalf("PICUserID = nil, want %q", *tc.wantVendor)
				}
				if *got.PICUserID != *tc.wantVendor {
					t.Errorf("PICUserID = %q, want %q", *got.PICUserID, *tc.wantVendor)
				}
			}
		})
	}
}

func TestListVisits_NormalisesPagination(t *testing.T) {
	cases := []struct {
		name      string
		page      int
		limit     int
		wantPage  int
		wantLimit int
	}{
		{"zero page and limit", 0, 0, 1, 20},
		{"negative page", -3, 10, 1, 10},
		{"limit over cap", 1, 500, 1, 20},
		{"negative limit", 2, -5, 2, 20},
		{"valid pair passes through", 2, 10, 2, 10},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			repo := newFakeVisitRepo(t)
			svc := newTestService(repo, nil, testNow())
			actor := testActor(domain.RoleSuperAdmin, "super-1", "")

			if _, _, err := svc.ListVisits(context.Background(), actor, ListVisitsInput{Page: tc.page, Limit: tc.limit}); err != nil {
				t.Fatalf("ListVisits returned error: %v", err)
			}
			if repo.lastFilter.Page != tc.wantPage {
				t.Errorf("Page = %d, want %d", repo.lastFilter.Page, tc.wantPage)
			}
			if repo.lastFilter.Limit != tc.wantLimit {
				t.Errorf("Limit = %d, want %d", repo.lastFilter.Limit, tc.wantLimit)
			}
		})
	}
}
