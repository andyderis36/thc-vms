package auth

import (
	"context"
	"testing"

	"thc-vms/backend/internal/domain"
)

// fakeVendors resolves company names from a map for profile tests.
type fakeVendors struct {
	names map[domain.UUID]string
	err   error
}

func (f fakeVendors) ListVendors(_ context.Context) ([]domain.Vendor, error) {
	return nil, nil
}

func (f fakeVendors) FindVendorName(_ context.Context, id domain.UUID) (string, error) {
	if f.err != nil {
		return "", f.err
	}
	name, ok := f.names[id]
	if !ok {
		return "", domain.ErrNotFound
	}
	return name, nil
}

func vendorWithVendor(hash string) domain.User {
	vendor := domain.UUID("vendor-lintas")
	return domain.User{
		ID:           "user-vendor-1",
		Name:         "Teknisi Vendor",
		Email:        "vendor@vendor.local",
		PasswordHash: hash,
		Phone:        "0812",
		RoleID:       "role-vendor",
		LocationID:   nil,
		Type:         domain.UserTypeExternal,
		Status:       domain.UserStatusActive,
		VendorID:     &vendor,
	}
}

// TestMe_ResolvesVendorName pins the vendor company display: the login/me
// projection carries vendor_name resolved through the vendors port.
func TestMe_ResolvesVendorName(t *testing.T) {
	users := &fakeUsers{byEmail: map[string]domain.User{}, byID: map[domain.UUID]domain.User{}}
	vendor := vendorWithVendor(hashPassword(t, "Password123!"))
	users.byEmail["vendor@vendor.local"] = vendor
	users.byID[vendor.ID] = vendor
	deps := loginDeps(users)
	deps.Vendors = fakeVendors{names: map[domain.UUID]string{"vendor-lintas": "PT Lintas Fiber"}}
	svc := NewService(deps)

	got, err := svc.Me(context.Background(), "user-vendor-1")
	if err != nil {
		t.Fatalf("Me: %v", err)
	}
	if got.VendorName == nil || *got.VendorName != "PT Lintas Fiber" {
		t.Fatalf("vendor_name = %v, want PT Lintas Fiber", got.VendorName)
	}
}

// TestMe_VendorNameStaysNil covers the degraded paths: no catalogue wired
// (hermetic tests) or an unknown vendor id leaves VendorName nil instead of
// failing the profile read.
func TestMe_VendorNameStaysNil(t *testing.T) {
	users := &fakeUsers{byEmail: map[string]domain.User{}, byID: map[domain.UUID]domain.User{}}
	vendor := vendorWithVendor(hashPassword(t, "Password123!"))
	users.byEmail["vendor@vendor.local"] = vendor
	users.byID[vendor.ID] = vendor

	svc := NewService(loginDeps(users))
	got, err := svc.Me(context.Background(), "user-vendor-1")
	if err != nil {
		t.Fatalf("Me without catalogue: %v", err)
	}
	if got.VendorName != nil {
		t.Fatalf("vendor_name = %q, want nil without catalogue", *got.VendorName)
	}

	deps := loginDeps(users)
	deps.Vendors = fakeVendors{names: map[domain.UUID]string{}}
	svc = NewService(deps)
	got, err = svc.Me(context.Background(), "user-vendor-1")
	if err != nil {
		t.Fatalf("Me with unknown vendor: %v", err)
	}
	if got.VendorName != nil {
		t.Fatalf("vendor_name = %q, want nil for unknown vendor", *got.VendorName)
	}
}
