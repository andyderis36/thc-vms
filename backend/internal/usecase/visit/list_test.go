package visit

import (
	"context"
	"testing"

	"thc-vms/backend/internal/domain"
)

func TestListVisits_BuildsTheCorrectScopePerRole(t *testing.T) {
	locA := domain.UUID("loc-A")
	vendorID := domain.UUID("vendor-1")

	cases := []struct {
		name         string
		actor        Actor
		wantIDs      []domain.UUID
		wantGlobal   bool
		wantVendor   *domain.UUID
	}{
		{"super_admin sees all", testActor(domain.RoleSuperAdmin, "super-1", ""), nil, true, nil},
		{"admin locked to branch", testActor(domain.RoleAdmin, "admin-1", "loc-A"), []domain.UUID{locA}, false, nil},
		{"security locked to branch", testActor(domain.RoleSecurity, "sec-1", "loc-A"), []domain.UUID{locA}, false, nil},
		{"vendor locked to own visits", testActor(domain.RoleVendor, "vendor-1", ""), nil, false, &vendorID},
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
			if len(got.LocationIDs) != len(tc.wantIDs) {
				t.Errorf("LocationIDs = %v, want %v", got.LocationIDs, tc.wantIDs)
			} else {
				for i := range tc.wantIDs {
					if got.LocationIDs[i] != tc.wantIDs[i] {
						t.Errorf("LocationIDs = %v, want %v", got.LocationIDs, tc.wantIDs)
						break
					}
				}
			}
			if got.IsGlobal != tc.wantGlobal {
				t.Errorf("IsGlobal = %v, want %v", got.IsGlobal, tc.wantGlobal)
			}
			if tc.wantVendor == nil {
				if got.VendorUserID != nil {
					t.Errorf("VendorUserID = %q, want nil", *got.VendorUserID)
				}
			} else {
				if got.VendorUserID == nil {
					t.Fatalf("VendorUserID = nil, want %q", *tc.wantVendor)
				}
				if *got.VendorUserID != *tc.wantVendor {
					t.Errorf("VendorUserID = %q, want %q", *got.VendorUserID, *tc.wantVendor)
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
		{"zero page and limit", 0, 0, 1, 10},
		{"negative page", -3, 10, 1, 10},
		{"limit over cap", 1, 500, 1, 10},
		{"negative limit", 2, -5, 2, 10},
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
