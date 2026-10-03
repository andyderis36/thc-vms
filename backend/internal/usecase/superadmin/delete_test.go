package superadmin_test

import (
	"testing"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/superadmin"
)

func TestCheckUserDelete(t *testing.T) {
	actor := domain.UUID("actor-1")
	adminTarget := domain.ManagedUser{
		User: domain.User{ID: "target-1", Status: domain.UserStatusActive},
		Role: domain.RoleAdmin,
	}
	if err := superadmin.CheckUserDelete(actor, true, adminTarget); err != nil {
		t.Fatalf("deleting another admin must be allowed: %v", err)
	}

	mustAppError(t,
		superadmin.CheckUserDelete(actor, false, domain.ManagedUser{}),
		404, "NOT_FOUND")

	selfTarget := domain.ManagedUser{
		User: domain.User{ID: actor, Status: domain.UserStatusActive},
		Role: domain.RoleSuperAdmin,
	}
	err := superadmin.CheckUserDelete(actor, true, selfTarget)
	mustAppError(t, err, 403, "FORBIDDEN")
	if err.Error() != "Tidak dapat menghapus akun sendiri." {
		t.Fatalf("self-delete message = %q, want the contract sentence", err.Error())
	}

	otherSuperAdmin := domain.ManagedUser{
		User: domain.User{ID: "target-9", Status: domain.UserStatusActive},
		Role: domain.RoleSuperAdmin,
	}
	err = superadmin.CheckUserDelete(actor, true, otherSuperAdmin)
	mustAppError(t, err, 403, "FORBIDDEN")
	if err.Error() != "Akun superadmin tidak dapat dihapus." {
		t.Fatalf("superadmin-delete message = %q, want the contract sentence", err.Error())
	}
}

func TestCheckUserReferences(t *testing.T) {
	if err := superadmin.CheckUserReferences(0, 0); err != nil {
		t.Fatalf("unreferenced account must be deletable: %v", err)
	}
	err := superadmin.CheckUserReferences(2, 0)
	mustAppError(t, err, 409, "CONFLICT")
	if got := err.Error(); got == "" {
		t.Fatal("vendor-reference refusal must carry a message")
	}
	err = superadmin.CheckUserReferences(0, 3)
	mustAppError(t, err, 409, "CONFLICT")
	if got := err.Error(); got == "" {
		t.Fatal("staff-reference refusal must carry a message")
	}
}

func TestCheckLocationReferences(t *testing.T) {
	if err := superadmin.CheckLocationReferences(0, 0); err != nil {
		t.Fatalf("unreferenced facility must be deletable: %v", err)
	}
	err := superadmin.CheckLocationReferences(2, 0)
	mustAppError(t, err, 409, "CONFLICT")
	if got := err.Error(); got == "" {
		t.Fatal("user-reference refusal must carry a message")
	}
	err = superadmin.CheckLocationReferences(0, 5)
	mustAppError(t, err, 409, "CONFLICT")
	if got := err.Error(); got == "" {
		t.Fatal("visit-reference refusal must carry a message")
	}
}
