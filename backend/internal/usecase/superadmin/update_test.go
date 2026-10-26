package superadmin_test

import (
	"testing"

	"golang.org/x/crypto/bcrypt"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/superadmin"
)

func uuidPtr(s string) *domain.UUID {
	id := domain.UUID(s)
	return &id
}

// TestValidateManagedUserUpdate pins the PATCH /users/:id contract: an
// all-empty patch is 400, provided name/email must be non-blank, and
// location/vendor follow the target's current role exactly like create.
func TestValidateManagedUserUpdate(t *testing.T) {
	const locID = "11111111-1111-1111-1111-111111111111"

	valid := []superadmin.ManagedUserPatchInput{
		{Role: domain.RoleAdmin, Name: strPtr("Baru")},
		{Role: domain.RoleAdmin, Email: strPtr("b@thc.local"), Phone: strPtr("080012345678")},
		{Role: domain.RoleVendor, Phone: strPtr("080112345678")},
		{Role: domain.RoleSecurity, Name: strPtr("Pengawas Baru")},
		{Role: domain.RoleSuperAdmin, Name: strPtr("Pusat Baru")},
		{Role: domain.RoleAdmin, LocationID: uuidPtr(locID)},
		{Role: domain.RoleVendor, Password: strPtr("Baru1234!")},
	}
	for i, in := range valid {
		if err := superadmin.ValidateManagedUserUpdate(in); err != nil {
			t.Fatalf("valid case %d: unexpected error: %v", i, err)
		}
	}

	cases := []struct {
		name  string
		input superadmin.ManagedUserPatchInput
	}{
		{"empty patch", superadmin.ManagedUserPatchInput{Role: domain.RoleAdmin}},
		{"empty password", superadmin.ManagedUserPatchInput{Role: domain.RoleAdmin, Password: strPtr("")}},
		{"blank name", superadmin.ManagedUserPatchInput{Role: domain.RoleAdmin, Name: strPtr("  ")}},
		{"blank email", superadmin.ManagedUserPatchInput{Role: domain.RoleVendor, Email: strPtr("")}},
		{"admin with vendor", superadmin.ManagedUserPatchInput{Role: domain.RoleAdmin, VendorID: uuidPtr(locID)}},
		{"vendor with location", superadmin.ManagedUserPatchInput{Role: domain.RoleVendor, LocationID: uuidPtr(locID)}},
		{"superadmin with location", superadmin.ManagedUserPatchInput{Role: domain.RoleSuperAdmin, LocationID: uuidPtr(locID)}},
		{"superadmin with vendor", superadmin.ManagedUserPatchInput{Role: domain.RoleSuperAdmin, VendorID: uuidPtr(locID)}},
		{"unknown role", superadmin.ManagedUserPatchInput{Role: domain.RoleName("owner"), Name: strPtr("X")}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mustAppError(t, superadmin.ValidateManagedUserUpdate(tc.input), 400, "VALIDATION_ERROR")
		})
	}
}

// TestCheckManagedPasswordReset pins the anti-persistence rule: another
// super_admin row is untouchable, resetting your own account requires proving
// the current password, and ordinary targets need no proof.
func TestCheckManagedPasswordReset(t *testing.T) {
	hash, err := bcrypt.GenerateFromPassword([]byte("Lama123!"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	hashStr := string(hash)
	otherSuper := domain.ManagedUser{User: domain.User{ID: "pusat-9", PasswordHash: hashStr}, Role: domain.RoleSuperAdmin}
	selfSuper := domain.ManagedUser{User: domain.User{ID: "actor-1", PasswordHash: hashStr}, Role: domain.RoleSuperAdmin}
	plainAdmin := domain.ManagedUser{User: domain.User{ID: "adm-1"}, Role: domain.RoleAdmin}

	if err := superadmin.CheckManagedPasswordReset("actor-1", plainAdmin, nil); err != nil {
		t.Fatalf("non-superadmin target needs no proof: %v", err)
	}
	mustAppError(t, superadmin.CheckManagedPasswordReset("actor-1", otherSuper, strPtr("Lama123!")), 403, "FORBIDDEN")
	mustAppError(t, superadmin.CheckManagedPasswordReset("actor-1", selfSuper, nil), 400, "VALIDATION_ERROR")
	mustAppError(t, superadmin.CheckManagedPasswordReset("actor-1", selfSuper, strPtr("Salah!")), 401, "INVALID_CREDENTIALS")
	if err := superadmin.CheckManagedPasswordReset("actor-1", selfSuper, strPtr("Lama123!")); err != nil {
		t.Fatalf("correct proof must pass: %v", err)
	}
}
