package visit

import (
	"errors"
	"testing"

	"thc-vms/backend/internal/domain"
)

// TestRequireBranchAccess_Matrix pins the branch-membership guard: super_admin
// passes everywhere; a stashed global passes; a union member passes even when
// the scalar primary points elsewhere; anything else falls back to the scalar
// rule; vendor is refused. Error sentinels and messages are unchanged.
func TestRequireBranchAccess_Matrix(t *testing.T) {
	t.Parallel()
	locA := domain.UUID("loc-A")
	locB := domain.UUID("loc-B")
	locC := domain.UUID("loc-C")
	ptr := func(id domain.UUID) *domain.UUID { return &id }

	cases := []struct {
		name   string
		actor  Actor
		target domain.UUID
		allow  bool
	}{
		{
			name:   "super_admin passes everywhere",
			actor:  Actor{ID: "super-1", Role: domain.RoleSuperAdmin},
			target: locA,
			allow:  true,
		},
		{
			name:   "dev-superadmin passes everywhere",
			actor:  Actor{ID: "dev-1", Role: domain.RoleDevSuperAdmin},
			target: locB,
			allow:  true,
		},
		{
			name:   "global scope passes foreign branch",
			actor:  Actor{ID: "adm-1", Role: domain.RoleAdmin, LocationID: ptr(locA), IsGlobal: true},
			target: locB,
			allow:  true,
		},
		{
			name:   "union member passes despite scalar mismatch",
			actor:  Actor{ID: "adm-1", Role: domain.RoleAdmin, LocationID: ptr(locB), Branches: []domain.UUID{locA, locC}},
			target: locA,
			allow:  true,
		},
		{
			name:   "security union member passes",
			actor:  Actor{ID: "sec-1", Role: domain.RoleSecurity, LocationID: ptr(locB), Branches: []domain.UUID{locA}},
			target: locA,
			allow:  true,
		},
		{
			name:   "non-member with scalar match falls back to allow",
			actor:  Actor{ID: "adm-1", Role: domain.RoleAdmin, LocationID: ptr(locA), Branches: []domain.UUID{locB}},
			target: locA,
			allow:  true,
		},
		{
			name:   "no scope scalar match allows",
			actor:  Actor{ID: "adm-1", Role: domain.RoleAdmin, LocationID: ptr(locA)},
			target: locA,
			allow:  true,
		},
		{
			name:   "non-member scalar mismatch refuses",
			actor:  Actor{ID: "adm-1", Role: domain.RoleAdmin, LocationID: ptr(locA), Branches: []domain.UUID{locB}},
			target: locC,
			allow:  false,
		},
		{
			name:   "no scope scalar mismatch refuses",
			actor:  Actor{ID: "adm-1", Role: domain.RoleAdmin, LocationID: ptr(locA)},
			target: locB,
			allow:  false,
		},
		{
			name:   "nil location without scope refuses",
			actor:  Actor{ID: "adm-1", Role: domain.RoleAdmin},
			target: locA,
			allow:  false,
		},
		{
			name:   "vendor is refused",
			actor:  Actor{ID: "vendor-1", Role: domain.RoleVendor},
			target: locA,
			allow:  false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			err := tc.actor.requireBranchAccess(tc.target)
			if tc.allow && err != nil {
				t.Fatalf("requireBranchAccess refused: %v", err)
			}
			if !tc.allow && !errors.Is(err, domain.ErrForbiddenBranch) {
				t.Fatalf("error = %v, want ErrForbiddenBranch", err)
			}
		})
	}
}
