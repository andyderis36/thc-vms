package visit

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"thc-vms/backend/internal/domain"
)

// TestCreateVisit_AdminChoosesVendorAccount pins the T2 ownership split: an
// admin/superadmin naming an active vendor account stores that account as the
// visit owner while created_by records the submitting actor, for every
// privileged role the create edge admits.
func TestCreateVisit_AdminChoosesVendorAccount(t *testing.T) {
	t.Parallel()
	actors := map[domain.RoleName]Actor{
		domain.RoleAdmin:         testActor(domain.RoleAdmin, "admin-1", "loc-A"),
		domain.RoleSuperAdmin:    testActor(domain.RoleSuperAdmin, "super-1", ""),
		domain.RoleDevSuperAdmin: testActor(domain.RoleDevSuperAdmin, "dev-1", ""),
	}
	for role, actor := range actors {
		role, actor := role, actor
		t.Run(string(role), func(t *testing.T) {
			t.Parallel()
			repo := newFakeVisitRepo(t)
			lookup := &fakeAccountLookup{accounts: map[domain.UUID]domain.ManagedUser{
				"vendor-9": visitVendorAccount("vendor-9", domain.UserStatusActive),
			}}
			svc := newTestServiceWithAccounts(repo, lookup)

			chosen := domain.UUID("vendor-9")
			in := validCreateInput()
			in.VendorUserID = &chosen

			got, err := svc.CreateVisit(context.Background(), actor, in)
			if err != nil {
				t.Fatalf("role %s: CreateVisit returned error: %v", role, err)
			}
			if repo.createdVisit.VendorUserID != chosen {
				t.Errorf("role %s: stored VendorUserID = %q, want %q", role, repo.createdVisit.VendorUserID, chosen)
			}
			if repo.createdVisit.CreatedBy == nil || *repo.createdVisit.CreatedBy != actor.ID {
				t.Errorf("role %s: stored CreatedBy = %v, want %q", role, repo.createdVisit.CreatedBy, actor.ID)
			}
			if got.CreatedBy == nil || *got.CreatedBy != actor.ID {
				t.Errorf("role %s: echoed CreatedBy = %v, want %q", role, got.CreatedBy, actor.ID)
			}
			if lookup.calls != 1 {
				t.Errorf("role %s: account lookups = %d, want 1", role, lookup.calls)
			}
		})
	}
}

// TestCreateVisit_AbsentVendorAccountKeepsActorOwnership pins the regression
// guard: without vendor_user_id today's behaviour is untouched (the actor
// owns the visit, created_by is the same actor) and no directory probe runs.
func TestCreateVisit_AbsentVendorAccountKeepsActorOwnership(t *testing.T) {
	t.Parallel()
	actor := testActor(domain.RoleAdmin, "admin-1", "loc-A")
	repo := newFakeVisitRepo(t)
	lookup := &fakeAccountLookup{}
	svc := newTestServiceWithAccounts(repo, lookup)

	got, err := svc.CreateVisit(context.Background(), actor, validCreateInput())
	if err != nil {
		t.Fatalf("CreateVisit returned error: %v", err)
	}
	if repo.createdVisit.VendorUserID != actor.ID {
		t.Errorf("VendorUserID = %q, want the actor %q", repo.createdVisit.VendorUserID, actor.ID)
	}
	if repo.createdVisit.CreatedBy == nil || *repo.createdVisit.CreatedBy != actor.ID {
		t.Errorf("CreatedBy = %v, want the actor %q", repo.createdVisit.CreatedBy, actor.ID)
	}
	if got.VendorUserID != actor.ID {
		t.Errorf("echoed VendorUserID = %q, want the actor %q", got.VendorUserID, actor.ID)
	}
	if lookup.calls != 0 {
		t.Errorf("account lookups = %d, want 0 when no account was named", lookup.calls)
	}
}

// TestCreateVisit_VendorCannotClaimAnotherAccount pins the vendor rule: an
// explicit foreign id is refused 403 before any write or directory probe, so
// a vendor can never take ownership of another vendor's request silently.
func TestCreateVisit_VendorCannotClaimAnotherAccount(t *testing.T) {
	t.Parallel()
	actor := testActor(domain.RoleVendor, "vendor-1", "")
	repo := newFakeVisitRepo(t)
	lookup := &fakeAccountLookup{}
	svc := newTestServiceWithAccounts(repo, lookup)

	foreign := domain.UUID("vendor-2")
	in := validCreateInput()
	in.VendorUserID = &foreign

	_, err := svc.CreateVisit(context.Background(), actor, in)
	var appErr *domain.AppError
	if !errors.As(err, &appErr) {
		t.Fatalf("error = %v, want an *domain.AppError", err)
	}
	if appErr.Status != http.StatusForbidden || appErr.Code != "FORBIDDEN" {
		t.Fatalf("error = %d %s, want 403 FORBIDDEN", appErr.Status, appErr.Code)
	}
	if repo.createCalls != 0 {
		t.Errorf("createCalls = %d, want 0", repo.createCalls)
	}
	if lookup.calls != 0 {
		t.Errorf("account lookups = %d, want 0 for a vendor caller", lookup.calls)
	}
}

// TestCreateVisit_VendorMayNameItself keeps the explicit self-id path open:
// the owning account equals the actor and created_by is that same actor.
func TestCreateVisit_VendorMayNameItself(t *testing.T) {
	t.Parallel()
	actor := testActor(domain.RoleVendor, "vendor-1", "")
	repo := newFakeVisitRepo(t)
	svc := newTestServiceWithAccounts(repo, &fakeAccountLookup{})

	own := domain.UUID("vendor-1")
	in := validCreateInput()
	in.VendorUserID = &own

	got, err := svc.CreateVisit(context.Background(), actor, in)
	if err != nil {
		t.Fatalf("self-named vendor create refused: %v", err)
	}
	if repo.createdVisit.VendorUserID != own || got.VendorUserID != own {
		t.Errorf("VendorUserID stored/echoed = %q/%q, want %q", repo.createdVisit.VendorUserID, got.VendorUserID, own)
	}
	if repo.createdVisit.CreatedBy == nil || *repo.createdVisit.CreatedBy != actor.ID {
		t.Errorf("CreatedBy = %v, want the actor %q", repo.createdVisit.CreatedBy, actor.ID)
	}
}

// TestCreateVisit_RejectsUnusableVendorAccount pins the admin-side validation:
// a non-vendor account and an inactive vendor are both refused as 422
// validation failures (never a 404 that would leak account existence) with a
// message naming the actual reason, and nothing is written.
func TestCreateVisit_RejectsUnusableVendorAccount(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name    string
		account domain.ManagedUser
		wantMsg string
	}{
		{
			name:    "non-vendor account",
			account: domain.ManagedUser{User: domain.User{ID: "acc-1", Status: domain.UserStatusActive}, Role: domain.RoleAdmin},
			wantMsg: "bukan akun vendor",
		},
		{
			name:    "inactive vendor account",
			account: visitVendorAccount("acc-1", domain.UserStatusInactive),
			wantMsg: "tidak aktif",
		},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			actor := testActor(domain.RoleAdmin, "admin-1", "loc-A")
			repo := newFakeVisitRepo(t)
			lookup := &fakeAccountLookup{accounts: map[domain.UUID]domain.ManagedUser{"acc-1": tc.account}}
			svc := newTestServiceWithAccounts(repo, lookup)

			chosen := domain.UUID("acc-1")
			in := validCreateInput()
			in.VendorUserID = &chosen

			_, err := svc.CreateVisit(context.Background(), actor, in)
			if !errors.Is(err, domain.ErrValidation) {
				t.Fatalf("error = %v, want a validation failure", err)
			}
			if !strings.Contains(err.Error(), tc.wantMsg) {
				t.Errorf("message %q must name %q", err.Error(), tc.wantMsg)
			}
			if repo.createCalls != 0 {
				t.Errorf("createCalls = %d, want 0", repo.createCalls)
			}
		})
	}
}

// TestCreateVisit_RejectsUnknownVendorAccount pins the unknown-id path: the
// directory miss is reported as a validation failure, never a stored row.
func TestCreateVisit_RejectsUnknownVendorAccount(t *testing.T) {
	t.Parallel()
	actor := testActor(domain.RoleAdmin, "admin-1", "loc-A")
	repo := newFakeVisitRepo(t)
	svc := newTestServiceWithAccounts(repo, &fakeAccountLookup{accounts: map[domain.UUID]domain.ManagedUser{}})

	ghost := domain.UUID("vendor-ghost")
	in := validCreateInput()
	in.VendorUserID = &ghost

	_, err := svc.CreateVisit(context.Background(), actor, in)
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("error = %v, want a validation failure", err)
	}
	if !strings.Contains(err.Error(), "tidak ditemukan") {
		t.Errorf("message %q must say the account was not found", err.Error())
	}
	if repo.createCalls != 0 {
		t.Errorf("createCalls = %d, want 0", repo.createCalls)
	}
}

// TestCreateVisit_ExplicitVendorAccountFailsClosedWithoutLookup pins the
// composition guarantee: when the account directory is not wired, an explicit
// vendor_user_id is refused instead of being trusted blindly.
func TestCreateVisit_ExplicitVendorAccountFailsClosedWithoutLookup(t *testing.T) {
	t.Parallel()
	actor := testActor(domain.RoleAdmin, "admin-1", "loc-A")
	repo := newFakeVisitRepo(t)
	svc := newTestService(repo, nil, testNow())

	chosen := domain.UUID("vendor-9")
	in := validCreateInput()
	in.VendorUserID = &chosen

	_, err := svc.CreateVisit(context.Background(), actor, in)
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("error = %v, want a validation failure", err)
	}
	if repo.createCalls != 0 {
		t.Errorf("createCalls = %d, want 0", repo.createCalls)
	}
}
