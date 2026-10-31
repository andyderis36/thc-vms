package superadmin_test

import (
	"strings"
	"testing"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/superadmin"
)

// vendorCreate builds the smallest valid POST /users body for an external vendor,
// with an optional manual company appended.
func vendorCreate(vendorID *domain.UUID, vendorName string) superadmin.ManagedUserInput {
	return superadmin.ManagedUserInput{
		Name:       "Teknisi Vendor",
		Email:      "teknisi@vendor.local",
		Password:   "Secret123!",
		NIK:        "3578010300000001",
		Role:       domain.RoleVendor,
		VendorID:   vendorID,
		VendorName: vendorName,
	}
}

// TestValidateManagedUserCreate_ManualVendorNameAccepted pins the happy path of
// the manual vendor company: a typed name with no catalogue link is a valid create
// and derives the external account type, so a vendor whose company is not (and
// must never become) catalogue master data can still hold an account.
func TestValidateManagedUserCreate_ManualVendorNameAccepted(t *testing.T) {
	typ, err := superadmin.ValidateManagedUserCreate(vendorCreate(nil, "PT Subkon Mandiri"))
	if err != nil {
		t.Fatalf("manual company without vendor_id must be accepted: %v", err)
	}
	if typ != domain.UserTypeExternal {
		t.Fatalf("account type = %q, want external for a vendor", typ)
	}

	// Absent entirely: the pre-000005 contract must keep working.
	typ, err = superadmin.ValidateManagedUserCreate(vendorCreate(nil, ""))
	if err != nil || typ != domain.UserTypeExternal {
		t.Fatalf("omitted manual company must still be accepted, got %q, %v", typ, err)
	}

	// Sent together with a catalogue link: validation permits the pair because
	// vendor_id wins at resolve time (see the visit-side precedence tests), so
	// the write path must not refuse a body the form can legitimately produce.
	vendor := domain.UUID("22222222-2222-2222-2222-222222222222")
	if _, err := superadmin.ValidateManagedUserCreate(vendorCreate(&vendor, "PT Subkon Mandiri")); err != nil {
		t.Fatalf("vendor_id + manual name must validate, resolution decides the winner: %v", err)
	}
}

// TestValidateManagedUserCreate_ManualVendorNameLength pins the 120-rune cap on
// the trimmed value: 120 passes, 121 is a 400. Padding spaces must not count
// toward the limit, and the cap is a rune count so multi-byte company names are
// not penalised by their byte length.
func TestValidateManagedUserCreate_ManualVendorNameLength(t *testing.T) {
	if _, err := superadmin.ValidateManagedUserCreate(vendorCreate(nil, strings.Repeat("A", 120))); err != nil {
		t.Fatalf("120-rune manual company must be accepted: %v", err)
	}

	if _, err := superadmin.ValidateManagedUserCreate(vendorCreate(nil, strings.Repeat("A", 121))); err == nil {
		t.Fatal("121-rune manual company must be refused, got nil error")
	} else {
		mustAppError(t, err, 400, "VALIDATION_ERROR")
	}

	// Surrounding whitespace is trimmed before the count, so a padded 120-rune
	// value is still inside the limit.
	padded := "  " + strings.Repeat("A", 120) + "  "
	if _, err := superadmin.ValidateManagedUserCreate(vendorCreate(nil, padded)); err != nil {
		t.Fatalf("whitespace must be trimmed before counting, got: %v", err)
	}

	// Rune, not byte: 120 multi-byte runes are far more than 120 bytes.
	multibyte := strings.Repeat("é", 120)
	if len(multibyte) <= 120 {
		t.Fatalf("fixture must exceed 120 bytes to prove a rune count, got %d", len(multibyte))
	}
	if _, err := superadmin.ValidateManagedUserCreate(vendorCreate(nil, multibyte)); err != nil {
		t.Fatalf("120 multi-byte runes must be accepted, got: %v", err)
	}
	if _, err := superadmin.ValidateManagedUserCreate(vendorCreate(nil, strings.Repeat("é", 121))); err == nil {
		t.Fatal("121 multi-byte runes must be refused, got nil error")
	}
}

// TestValidateManagedUserCreate_ManualVendorNameIsVendorOnly pins the role gate: an
// internal account (admin carries a branch) must never be given a vendor
// company, so the manual column cannot end up describing THC's own staff.
func TestValidateManagedUserCreate_ManualVendorNameIsVendorOnly(t *testing.T) {
	loc := domain.UUID("11111111-1111-1111-1111-111111111111")
	vendor := domain.UUID("22222222-2222-2222-2222-222222222222")

	admin := superadmin.ManagedUserInput{
		Name: "Admin Cabang", Email: "admin@thc.local", Password: "Secret123!",
		NIK: "3578010400000001", Role: domain.RoleAdmin, LocationID: &loc,
		VendorName: "PT Subkon Mandiri",
	}
	if _, err := superadmin.ValidateManagedUserCreate(admin); err == nil {
		t.Fatal("admin with vendor_name must be refused, got nil error")
	} else {
		mustAppError(t, err, 400, "VALIDATION_ERROR")
	}

	// An admin that also names a catalogue vendor is refused on the same rule.
	admin.VendorID = &vendor
	if _, err := superadmin.ValidateManagedUserCreate(admin); err == nil {
		t.Fatal("admin with vendor_id and vendor_name must be refused, got nil error")
	}
}

// TestValidateManagedUserUpdate_ManualVendorNameTriState pins the phone-style
// tri-state of the manual company on PATCH /users/:id: absent keeps the stored
// column, a blank value clears it, a filled value sets it. The validation layer
// must accept the two meaningful states and refuse only the overlong one.
func TestValidateManagedUserUpdate_ManualVendorNameTriState(t *testing.T) {
	// Keep: no vendor_name member at all. It still needs another member or the
	// patch is empty, so pair it with a name edit.
	name := "Teknisi Baru"
	if err := superadmin.ValidateManagedUserUpdate(superadmin.ManagedUserPatchInput{
		Role: domain.RoleVendor, Name: &name,
	}); err != nil {
		t.Fatalf("a patch without vendor_name must keep the stored value: %v", err)
	}

	// Set: a filled value is the same rule as create.
	set := "PT Subkon Mandiri"
	if err := superadmin.ValidateManagedUserUpdate(superadmin.ManagedUserPatchInput{
		Role: domain.RoleVendor, VendorName: &set,
	}); err != nil {
		t.Fatalf("filled vendor_name must be accepted as a set: %v", err)
	}

	// Clear: a blank value is meaningful (it empties the column), so it must
	// never be mistaken for "keep".
	blank := "   "
	if err := superadmin.ValidateManagedUserUpdate(superadmin.ManagedUserPatchInput{
		Role: domain.RoleVendor, VendorName: &blank,
	}); err != nil {
		t.Fatalf("blank vendor_name must be accepted as a clear: %v", err)
	}

	// Overlong is refused on the same 400 as create.
	tooLong := strings.Repeat("B", 121)
	if err := superadmin.ValidateManagedUserUpdate(superadmin.ManagedUserPatchInput{
		Role: domain.RoleVendor, VendorName: &tooLong,
	}); err == nil {
		t.Fatal("121-rune vendor_name patch must be refused, got nil error")
	} else {
		mustAppError(t, err, 400, "VALIDATION_ERROR")
	}

	// A padded 120-rune value is inside the limit.
	padded := "  " + strings.Repeat("B", 120) + "\t "
	if err := superadmin.ValidateManagedUserUpdate(superadmin.ManagedUserPatchInput{
		Role: domain.RoleVendor, VendorName: &padded,
	}); err != nil {
		t.Fatalf("padded 120-rune vendor_name must be accepted: %v", err)
	}
}

// TestValidateManagedUserUpdate_ManualVendorNameIsVendorOnly pins the role gate on
// the patch path for every non-vendor role, including super_admin: a manual company
// may only ever describe an external technician.
func TestValidateManagedUserUpdate_ManualVendorNameIsVendorOnly(t *testing.T) {
	loc := domain.UUID("11111111-1111-1111-1111-111111111111")
	vendorName := "PT Subkon Mandiri"

	for _, role := range []domain.RoleName{
		domain.RoleAdmin, domain.RoleSecurity, domain.RoleSuperAdmin, domain.RoleDevSuperAdmin,
	} {
		if err := superadmin.ValidateManagedUserUpdate(superadmin.ManagedUserPatchInput{
			Role: role, VendorName: &vendorName,
		}); err == nil {
			t.Fatalf("role %s: vendor_name patch must be refused, got nil error", role)
		} else {
			mustAppError(t, err, 400, "VALIDATION_ERROR")
		}
	}

	// An admin patch that only carries a blank vendor_name is refused too: the
	// clear signal is still a vendor assertion, not a way to touch the column.
	blank := ""
	locPatch := superadmin.ManagedUserPatchInput{Role: domain.RoleAdmin, VendorName: &blank}
	if err := superadmin.ValidateManagedUserUpdate(locPatch); err == nil {
		t.Fatal("blank vendor_name on an admin must be refused, got nil error")
	}

	// A vendor patch may set or clear freely, including with a catalogue link.
	vendor := domain.UUID("22222222-2222-2222-2222-222222222222")
	if err := superadmin.ValidateManagedUserUpdate(superadmin.ManagedUserPatchInput{
		Role: domain.RoleVendor, VendorID: &vendor, VendorName: &vendorName,
	}); err != nil {
		t.Fatalf("vendor may carry vendor_id and vendor_name together: %v", err)
	}
	if err := superadmin.ValidateManagedUserUpdate(superadmin.ManagedUserPatchInput{
		Role: domain.RoleVendor, LocationID: &loc,
	}); err == nil {
		t.Fatal("vendor must still be refused a location_id, got nil error")
	}
}
