package superadmin_test

import (
	"errors"
	"testing"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/superadmin"
)

// mustAppError asserts the error is a *domain.AppError with the wanted
// status and envelope code.
func mustAppError(t *testing.T, err error, status int, code string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected error (%d %s), got nil", status, code)
	}
	var appErr *domain.AppError
	if !errors.As(err, &appErr) {
		t.Fatalf("expected *domain.AppError, got %T: %v", err, err)
	}
	if appErr.Status != status || appErr.Code != code {
		t.Fatalf("status/code = %d/%s, want %d/%s: %q", appErr.Status, appErr.Code, status, code, appErr.Message)
	}
	if appErr.Message == "" {
		t.Fatal("user message must not be empty")
	}
}

func TestValidateLocationCreate(t *testing.T) {
	for _, locType := range []domain.LocationType{
		domain.LocationPusat, domain.LocationCabang, domain.LocationPOP, domain.LocationMiniPOP,
	} {
		if err := superadmin.ValidateLocationCreate(superadmin.LocationCreateInput{Name: "Cabang Baru", Type: locType}); err != nil {
			t.Fatalf("type %s must be accepted: %v", locType, err)
		}
	}
	mustAppError(t, superadmin.ValidateLocationCreate(superadmin.LocationCreateInput{Name: "  ", Type: domain.LocationCabang}), 400, "VALIDATION_ERROR")
	mustAppError(t, superadmin.ValidateLocationCreate(superadmin.LocationCreateInput{Name: "X", Type: "head_office"}), 400, "VALIDATION_ERROR")
	mustAppError(t, superadmin.ValidateLocationCreate(superadmin.LocationCreateInput{Name: "X"}), 400, "VALIDATION_ERROR")
}

func TestNormalizeLocationTimezone(t *testing.T) {
	tz, err := superadmin.NormalizeLocationTimezone("")
	if err != nil || tz != domain.TimezoneWIB {
		t.Fatalf("empty timezone must default to WIB, got %q, %v", tz, err)
	}
	for _, want := range []domain.Timezone{domain.TimezoneWIB, domain.TimezoneWITA, domain.TimezoneWIT} {
		got, err := superadmin.NormalizeLocationTimezone(string(want))
		if err != nil || got != want {
			t.Fatalf("timezone %s must be accepted, got %q, %v", want, got, err)
		}
	}
	mustAppError(t, func() error { _, err := superadmin.NormalizeLocationTimezone("EST"); return err }(), 400, "VALIDATION_ERROR")
}

func strPtr(s string) *string { return &s }

func TestValidateLocationPatch(t *testing.T) {
	mustAppError(t, superadmin.ValidateLocationPatch(domain.LocationPatch{}), 400, "VALIDATION_ERROR")

	name := "Cabang Baru"
	if err := superadmin.ValidateLocationPatch(domain.LocationPatch{Name: &name}); err != nil {
		t.Fatalf("single name patch must be accepted: %v", err)
	}
	active := false
	if err := superadmin.ValidateLocationPatch(domain.LocationPatch{IsActive: &active}); err != nil {
		t.Fatalf("is_active-only patch must be accepted: %v", err)
	}

	blank := "  "
	mustAppError(t, superadmin.ValidateLocationPatch(domain.LocationPatch{Name: &blank}), 400, "VALIDATION_ERROR")
	badType := domain.LocationType("branch_office")
	mustAppError(t, superadmin.ValidateLocationPatch(domain.LocationPatch{Type: &badType}), 400, "VALIDATION_ERROR")
	badTZ := domain.Timezone("EST")
	mustAppError(t, superadmin.ValidateLocationPatch(domain.LocationPatch{Timezone: &badTZ}), 400, "VALIDATION_ERROR")
}

func TestValidateManagedUserCreate(t *testing.T) {
	loc := domain.UUID("11111111-1111-1111-1111-111111111111")
	vendor := domain.UUID("22222222-2222-2222-2222-222222222222")

	base := superadmin.ManagedUserInput{Name: "Admin Cabang", Email: "admin@thc.local", Password: "Secret123!"}

	typ, err := superadmin.ValidateManagedUserCreate(superadmin.ManagedUserInput{
		Name: base.Name, Email: base.Email, Password: base.Password,
		NIK: "3578010100000001", Role: domain.RoleAdmin, LocationID: &loc,
	})
	if err != nil || typ != domain.UserTypeInternal {
		t.Fatalf("admin with branch must be internal, got %q, %v", typ, err)
	}

	typ, err = superadmin.ValidateManagedUserCreate(superadmin.ManagedUserInput{
		Name: base.Name, Email: base.Email, Password: base.Password,
		NIK: "3578010200000001", Role: domain.RoleVendor, VendorID: &vendor,
	})
	if err != nil || typ != domain.UserTypeExternal {
		t.Fatalf("vendor without branch must be external, got %q, %v", typ, err)
	}

	cases := []struct {
		name  string
		input superadmin.ManagedUserInput
	}{
		{"blank name", superadmin.ManagedUserInput{Email: base.Email, Password: base.Password, Role: domain.RoleAdmin, LocationID: &loc}},
		{"blank email", superadmin.ManagedUserInput{Name: base.Name, Password: base.Password, Role: domain.RoleAdmin, LocationID: &loc}},
		{"blank password", superadmin.ManagedUserInput{Name: base.Name, Email: base.Email, Role: domain.RoleAdmin, LocationID: &loc}},
		{"admin without branch", superadmin.ManagedUserInput{Name: base.Name, Email: base.Email, Password: base.Password, Role: domain.RoleAdmin}},
		{"admin with vendor", superadmin.ManagedUserInput{Name: base.Name, Email: base.Email, Password: base.Password, Role: domain.RoleAdmin, LocationID: &loc, VendorID: &vendor}},
		{"vendor with branch", superadmin.ManagedUserInput{Name: base.Name, Email: base.Email, Password: base.Password, Role: domain.RoleVendor, LocationID: &loc}},
		{"super_admin refused", superadmin.ManagedUserInput{Name: base.Name, Email: base.Email, Password: base.Password, Role: domain.RoleSuperAdmin}},
		{"security refused", superadmin.ManagedUserInput{Name: base.Name, Email: base.Email, Password: base.Password, Role: domain.RoleSecurity, LocationID: &loc}},
		{"unknown role", superadmin.ManagedUserInput{Name: base.Name, Email: base.Email, Password: base.Password, Role: "owner"}},
	}
	for _, tc := range cases {
		if _, err := superadmin.ValidateManagedUserCreate(tc.input); err == nil {
			t.Fatalf("%s: expected 400, got nil", tc.name)
		} else {
			mustAppError(t, err, 400, "VALIDATION_ERROR")
		}
	}
}

func TestValidateUserListRole(t *testing.T) {
	role, err := superadmin.ValidateUserListRole("")
	if err != nil || role != nil {
		t.Fatalf("empty role must mean every role, got %v, %v", role, err)
	}
	for _, want := range []domain.RoleName{domain.RoleAdmin, domain.RoleVendor, domain.RoleSecurity} {
		got, err := superadmin.ValidateUserListRole(string(want))
		if err != nil || got == nil || *got != want {
			t.Fatalf("role %s must be accepted, got %v, %v", want, got, err)
		}
	}
	mustAppError(t, func() error { _, err := superadmin.ValidateUserListRole("super_admin"); return err }(), 400, "VALIDATION_ERROR")
	mustAppError(t, func() error { _, err := superadmin.ValidateUserListRole("owner"); return err }(), 400, "VALIDATION_ERROR")
}

func TestCheckUserStatusChange(t *testing.T) {
	actor := domain.UUID("actor-1")
	adminTarget := domain.ManagedUser{
		User: domain.User{ID: "target-1", Status: domain.UserStatusActive},
		Role: domain.RoleAdmin,
	}
	if err := superadmin.CheckUserStatusChange(actor, true, adminTarget, domain.UserStatusInactive); err != nil {
		t.Fatalf("admin flip must be allowed: %v", err)
	}

	mustAppError(t,
		superadmin.CheckUserStatusChange(actor, false, domain.ManagedUser{}, domain.UserStatusInactive),
		404, "NOT_FOUND")

	mustAppError(t,
		superadmin.CheckUserStatusChange(actor, true, adminTarget, "blacklisted"),
		400, "VALIDATION_ERROR")

	selfTarget := domain.ManagedUser{
		User: domain.User{ID: actor, Status: domain.UserStatusActive},
		Role: domain.RoleSuperAdmin,
	}
	err := superadmin.CheckUserStatusChange(actor, true, selfTarget, domain.UserStatusInactive)
	mustAppError(t, err, 403, "FORBIDDEN")
	if got := err.Error(); got == "" {
		t.Fatal("self-change refusal must carry a message")
	}

	otherSuperAdmin := domain.ManagedUser{
		User: domain.User{ID: "target-9", Status: domain.UserStatusActive},
		Role: domain.RoleSuperAdmin,
	}
	err = superadmin.CheckUserStatusChange(actor, true, otherSuperAdmin, domain.UserStatusInactive)
	mustAppError(t, err, 403, "FORBIDDEN")
}
