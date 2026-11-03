package auth

import (
	"context"
	"errors"
	"strings"
	"testing"

	"thc-vms/backend/internal/domain"
)

// fakeManagedUsers is a hand-written fake of domain.ManagedUserRepository: it
// records the created row and replays a canned duplicate-email error.
type fakeManagedUsers struct {
	created  []domain.User
	createErr error
}

func (f *fakeManagedUsers) ListManagedUsers(_ context.Context, _ domain.UserFilter) ([]domain.ManagedUser, error) {
	return nil, nil
}

func (f *fakeManagedUsers) CreateManagedUser(_ context.Context, user domain.User) (domain.User, error) {
	if f.createErr != nil {
		return domain.User{}, f.createErr
	}
	stored := user
	stored.ID = "user-vendor-new"
	f.created = append(f.created, stored)
	return stored, nil
}

func (f *fakeManagedUsers) FindManagedByID(_ context.Context, _ domain.UUID) (domain.ManagedUser, error) {
	return domain.ManagedUser{}, domain.ErrNotFound
}

func (f *fakeManagedUsers) UpdateStatus(_ context.Context, _ domain.UUID, _ domain.UserStatus) error {
	return nil
}

func (f *fakeManagedUsers) UpdateManagedUser(_ context.Context, id domain.UUID, _ domain.ManagedUserPatch) (domain.User, error) {
	return domain.User{ID: id}, nil
}

func (f *fakeManagedUsers) CountVisitsByVendorUser(_ context.Context, _ domain.UUID) (int64, error) {
	return 0, nil
}

func (f *fakeManagedUsers) CountStaffReferences(_ context.Context, _ domain.UUID) (int64, error) {
	return 0, nil
}

func (f *fakeManagedUsers) DeleteUser(_ context.Context, _ domain.UUID) error { return nil }

func registerDeps(managed *fakeManagedUsers, audit *fakeAudit) Deps {
	deps := loginDeps(&fakeUsers{byEmail: map[string]domain.User{}, byID: map[domain.UUID]domain.User{}})
	deps.Managed = managed
	deps.VendorRoleID = "role-vendor"
	if audit != nil {
		deps.Audit = audit
	}
	return deps
}

func validRegisterInput() RegisterVendorInput {
	return RegisterVendorInput{
		Name:     "Dimas Prasetyo",
		Email:    "dimas@vendor.example",
		Password: "Password123!",
		Phone:    "081234567890",
		NIK:      "3201010101900001",
	}
}

func TestRegisterVendor_CreatesPendingExternalVendor(t *testing.T) {
	managed := &fakeManagedUsers{}
	audit := &fakeAudit{}
	svc := NewService(registerDeps(managed, audit))

	got, err := svc.RegisterVendor(auditCtx(), validRegisterInput())
	if err != nil {
		t.Fatalf("RegisterVendor: %v", err)
	}
	if len(managed.created) != 1 {
		t.Fatalf("created rows = %d, want 1", len(managed.created))
	}
	stored := managed.created[0]
	if stored.Status != domain.UserStatusPending {
		t.Fatalf("status = %q, want pending (never immediately usable)", stored.Status)
	}
	if stored.Type != domain.UserTypeExternal {
		t.Fatalf("type = %q, want external", stored.Type)
	}
	if stored.LocationID != nil {
		t.Fatalf("location_id = %v, want nil for vendor", stored.LocationID)
	}
	if stored.RoleID != "role-vendor" {
		t.Fatalf("role_id = %q, want the vendor role", stored.RoleID)
	}
	if stored.VendorNameOverride != nil {
		t.Fatalf("vendor override = %v, want nil without a manual name", stored.VendorNameOverride)
	}
	if got.ID != "user-vendor-new" || got.Status != domain.UserStatusPending {
		t.Fatalf("profile = %+v, want the pending account", got)
	}
	if len(audit.entries) != 1 {
		t.Fatalf("audit entries = %d, want exactly 1", len(audit.entries))
	}
	entry := audit.entries[0]
	if entry.ActorID != nil {
		t.Fatalf("public registration must carry a nil actor, got %v", entry.ActorID)
	}
	if entry.Action != domain.AuditActionUserCreate || entry.Entity != domain.AuditEntityUser {
		t.Fatalf("audit = %q/%q, want user.create/user", entry.Action, entry.Entity)
	}
	if entry.EntityID == nil || *entry.EntityID != "user-vendor-new" {
		t.Fatalf("subject = %v, want the created account", entry.EntityID)
	}
	if entry.Metadata["email"] != "dimas@vendor.example" || entry.Metadata["role"] != "vendor" {
		t.Fatalf("metadata = %v, want secret-free email+role", entry.Metadata)
	}
	if entry.IP != "203.0.113.7" || entry.UserAgent != "AuditTest/1.0" {
		t.Fatalf("provenance = %+v, want the request meta", entry)
	}
	assertNoSecrets(t, audit.entries, "Password123!", "3201010101900001")
}

func TestRegisterVendor_ManualVendorNameBecomesOverrideCatalogueWins(t *testing.T) {
	managed := &fakeManagedUsers{}
	svc := NewService(registerDeps(managed, nil))

	in := validRegisterInput()
	in.VendorName = "PT Lintas Fiber Manual"
	if _, err := svc.RegisterVendor(context.Background(), in); err != nil {
		t.Fatalf("RegisterVendor: %v", err)
	}
	if got := managed.created[0].VendorNameOverride; got == nil || *got != "PT Lintas Fiber Manual" {
		t.Fatalf("vendor override = %v, want the manual name (never enters the catalogue)", got)
	}

	vendorID := domain.UUID("vendor-catalog-1")
	in.VendorID = &vendorID
	in.VendorName = "PT Lintas Fiber Manual"
	if _, err := svc.RegisterVendor(context.Background(), in); err != nil {
		t.Fatalf("RegisterVendor: %v", err)
	}
	second := managed.created[1]
	if second.VendorID == nil || *second.VendorID != vendorID {
		t.Fatalf("vendor_id = %v, want the catalogue link", second.VendorID)
	}
	if second.VendorNameOverride != nil {
		t.Fatalf("vendor override = %v, want nil when vendor_id wins", second.VendorNameOverride)
	}
}

func TestRegisterVendor_ValidationRejectsBadInput(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*RegisterVendorInput)
	}{
		{"empty name", func(in *RegisterVendorInput) { in.Name = "  " }},
		{"bad email", func(in *RegisterVendorInput) { in.Email = "not-an-email" }},
		{"short password", func(in *RegisterVendorInput) { in.Password = "short" }},
		{"bad phone", func(in *RegisterVendorInput) { in.Phone = "123" }},
		{"missing NIK", func(in *RegisterVendorInput) { in.NIK = "" }},
		{"short NIK", func(in *RegisterVendorInput) { in.NIK = "123" }},
		{"non-digit NIK", func(in *RegisterVendorInput) { in.NIK = "320101010190000X" }},
		{"long vendor name", func(in *RegisterVendorInput) { in.VendorName = strings.Repeat("x", 121) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			managed := &fakeManagedUsers{}
			svc := NewService(registerDeps(managed, nil))
			in := validRegisterInput()
			tc.mutate(&in)
			_, err := svc.RegisterVendor(context.Background(), in)
			if err == nil {
				t.Fatalf("%s: registration succeeded, want 400", tc.name)
			}
			got := appErrorOf(t, err)
			if got.Status != 400 || got.Code != "VALIDATION_ERROR" {
				t.Fatalf("%s: got (%d,%s), want (400,VALIDATION_ERROR)", tc.name, got.Status, got.Code)
			}
			if len(managed.created) != 0 {
				t.Fatalf("%s: row was stored despite validation failure", tc.name)
			}
		})
	}
}

func TestRegisterVendor_DuplicateEmailConflicts(t *testing.T) {
	managed := &fakeManagedUsers{createErr: domain.ErrConflict}
	svc := NewService(registerDeps(managed, nil))

	_, err := svc.RegisterVendor(context.Background(), validRegisterInput())
	if err == nil {
		t.Fatal("duplicate email succeeded, want 409")
	}
	if !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("error = %v, want the conflict sentinel", err)
	}
	if got := domain.FromError(err); got.Status != 409 || got.Code != "CONFLICT" {
		t.Fatalf("mapped = (%d,%s), want (409,CONFLICT)", got.Status, got.Code)
	}
}

func TestRegisterVendor_AuditFailureNeverFailsRegistration(t *testing.T) {
	managed := &fakeManagedUsers{}
	audit := &fakeAudit{appendErr: errors.New("trail unavailable")}
	svc := NewService(registerDeps(managed, audit))

	if _, err := svc.RegisterVendor(auditCtx(), validRegisterInput()); err != nil {
		t.Fatalf("registration must succeed despite audit failure: %v", err)
	}
	if len(managed.created) != 1 {
		t.Fatal("row was not stored when the trail was down")
	}
}

func TestRegisterVendor_UnwiredStoreFailsClosed(t *testing.T) {
	deps := loginDeps(&fakeUsers{byEmail: map[string]domain.User{}, byID: map[domain.UUID]domain.User{}})
	svc := NewService(deps)

	_, err := svc.RegisterVendor(context.Background(), validRegisterInput())
	if err == nil {
		t.Fatal("unwired registration succeeded, want 500")
	}
	if got := domain.FromError(err); got.Status != 500 {
		t.Fatalf("status = %d, want 500", got.Status)
	}
}
