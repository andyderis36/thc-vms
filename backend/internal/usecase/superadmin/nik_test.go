package superadmin_test

import (
	"testing"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/superadmin"
)

// TestValidNIK pins the digit rule mirroring chk_users_nik: exactly 16 ASCII
// digits, nothing else.
func TestValidNIK(t *testing.T) {
	valid := []string{"3578010100000001", "0000000000000000", "3578050200000010"}
	for _, nik := range valid {
		if !superadmin.ValidNIK(nik) {
			t.Errorf("ValidNIK(%q) = false, want true", nik)
		}
	}
	invalid := []string{
		"",
		"357801010000001",
		"35780101000000011",
		"35780101000000AB",
		"35780101000000A1",
		" 3578010100000001",
		"3578010100000001 ",
		"3578-0101-00000001",
	}
	for _, nik := range invalid {
		if superadmin.ValidNIK(nik) {
			t.Errorf("ValidNIK(%q) = true, want false", nik)
		}
	}
}

// TestValidateUserNIKMatrix pins the per-role rule: admin and vendor must carry
// a well-formed NIK, every other role must carry none.
func TestValidateUserNIKMatrix(t *testing.T) {
	const good = "3578010100000001"
	for _, role := range []domain.RoleName{domain.RoleAdmin, domain.RoleVendor} {
		if err := superadmin.ValidateUserNIK(role, good); err != nil {
			t.Errorf("role %s with a good NIK: %v", role, err)
		}
		for _, nik := range []string{"", "123", "35780101000000AB", "35780101000000011"} {
			if err := superadmin.ValidateUserNIK(role, nik); err == nil {
				t.Errorf("role %s with NIK %q: accepted, want 400", role, nik)
			}
		}
	}
	for _, role := range []domain.RoleName{domain.RoleSecurity, domain.RoleSuperAdmin} {
		if err := superadmin.ValidateUserNIK(role, ""); err != nil {
			t.Errorf("role %s without a NIK: %v", role, err)
		}
		if err := superadmin.ValidateUserNIK(role, good); err == nil {
			t.Errorf("role %s with a NIK: accepted, want 400", role)
		}
	}
}

// TestValidateManagedUserCreateNIK proves the create gate: a missing or
// malformed NIK refuses an admin/vendor row with 400, while the account type
// derivation is unchanged for valid rows.
func TestValidateManagedUserCreateNIK(t *testing.T) {
	const locID = "11111111-1111-1111-1111-111111111111"
	locationID := domain.UUID(locID)
	for _, tc := range []struct {
		name string
		in   superadmin.ManagedUserInput
		want domain.UserType
	}{
		{"admin with NIK", superadmin.ManagedUserInput{
			Name: "A", Email: "a@thc.local", Password: "Secret123!",
			NIK: "3578010100000001", Role: domain.RoleAdmin, LocationID: &locationID,
		}, domain.UserTypeInternal},
		{"vendor with NIK", superadmin.ManagedUserInput{
			Name: "P", Email: "p@vendor.local", Password: "Secret123!",
			NIK: "3578010200000001", Role: domain.RoleVendor,
		}, domain.UserTypeExternal},
	} {
		if got, err := superadmin.ValidateManagedUserCreate(tc.in); err != nil {
			t.Errorf("%s: %v", tc.name, err)
		} else if got != tc.want {
			t.Errorf("%s: type = %s, want %s", tc.name, got, tc.want)
		}
	}

	bad := []superadmin.ManagedUserInput{
		{Name: "A", Email: "a@thc.local", Password: "Secret123!",
			Role: domain.RoleAdmin, LocationID: &locationID},
		{Name: "A", Email: "a@thc.local", Password: "Secret123!",
			NIK: "123", Role: domain.RoleAdmin, LocationID: &locationID},
		{Name: "P", Email: "p@vendor.local", Password: "Secret123!",
			Role: domain.RoleVendor},
		{Name: "P", Email: "p@vendor.local", Password: "Secret123!",
			NIK: "35780102000000AB", Role: domain.RoleVendor},
	}
	for i, in := range bad {
		if _, err := superadmin.ValidateManagedUserCreate(in); err == nil {
			t.Errorf("bad create %d (%s): accepted, want 400", i, in.Role)
		}
	}
}

// TestValidateManagedUserUpdateNIK proves the update gate applies only when
// the key is provided: a nil NIK keeps the stored column without complaint,
// while a provided value follows the same per-role rule as create.
func TestValidateManagedUserUpdateNIK(t *testing.T) {
	good := "3578010100000001"
	str := func(s string) *string { return &s }

	if err := superadmin.ValidateManagedUserUpdate(superadmin.ManagedUserPatchInput{
		Role: domain.RoleAdmin, Name: str("Baru"),
	}); err != nil {
		t.Fatalf("nik-absent admin patch: %v", err)
	}
	if err := superadmin.ValidateManagedUserUpdate(superadmin.ManagedUserPatchInput{
		Role: domain.RoleAdmin, NIK: &good,
	}); err != nil {
		t.Fatalf("admin NIK set: %v", err)
	}
	if err := superadmin.ValidateManagedUserUpdate(superadmin.ManagedUserPatchInput{
		Role: domain.RoleVendor, NIK: &good,
	}); err != nil {
		t.Fatalf("vendor NIK set: %v", err)
	}

	bad := []superadmin.ManagedUserPatchInput{
		{Role: domain.RoleAdmin, NIK: str("")},
		{Role: domain.RoleAdmin, NIK: str("123")},
		{Role: domain.RoleVendor, NIK: str("")},
		{Role: domain.RoleSecurity, NIK: &good},
		{Role: domain.RoleSuperAdmin, NIK: &good},
	}
	for i, in := range bad {
		if err := superadmin.ValidateManagedUserUpdate(in); err == nil {
			t.Errorf("bad update %d (role %s): accepted, want 400", i, in.Role)
		}
	}
}
