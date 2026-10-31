package visit

import (
	"context"
	"errors"
	"strings"
	"testing"

	"thc-vms/backend/internal/domain"
)

// TestCreateVisit_VisitLevelVendorNameStored pins the visit-level manual
// company (migration 000017): trimmed text travels onto the stored row as the
// override while the catalogue VendorName stays empty. Every create role may
// send it — there is no role restriction beyond the existing create roles.
func TestCreateVisit_VisitLevelVendorNameStored(t *testing.T) {
	actors := map[domain.RoleName]Actor{
		domain.RoleVendor:     testActor(domain.RoleVendor, "vendor-1", ""),
		domain.RoleAdmin:      testActor(domain.RoleAdmin, "admin-1", "loc-A"),
		domain.RoleSuperAdmin: testActor(domain.RoleSuperAdmin, "super-1", ""),
	}
	for role, actor := range actors {
		repo := newFakeVisitRepo(t)
		svc := newTestService(repo, nil, testNow())

		typed := "  PT Kunjungan Mandiri  "
		in := validCreateInput()
		in.VendorName = &typed

		got, err := svc.CreateVisit(context.Background(), actor, in)
		if err != nil {
			t.Fatalf("role %s: CreateVisit returned error: %v", role, err)
		}
		if repo.createdVisit.VendorNameOverride == nil || *repo.createdVisit.VendorNameOverride != "PT Kunjungan Mandiri" {
			t.Errorf("role %s: stored VendorNameOverride = %v, want the trimmed company", role, repo.createdVisit.VendorNameOverride)
		}
		if repo.createdVisit.VendorName != "" {
			t.Errorf("role %s: stored VendorName = %q, want empty without a catalogue link", role, repo.createdVisit.VendorName)
		}
		if got.VendorNameOverride == nil || *got.VendorNameOverride != "PT Kunjungan Mandiri" {
			t.Errorf("role %s: echoed VendorNameOverride = %v, want the trimmed company", role, got.VendorNameOverride)
		}
	}
}

// TestCreateVisit_VisitLevelVendorNameEmptyStaysAbsent pins the absent case:
// a whitespace-only company maps to NULL, never to stored whitespace.
func TestCreateVisit_VisitLevelVendorNameEmptyStaysAbsent(t *testing.T) {
	repo := newFakeVisitRepo(t)
	svc := newTestService(repo, nil, testNow())
	actor := testActor(domain.RoleVendor, "vendor-1", "")

	blank := "   "
	in := validCreateInput()
	in.VendorName = &blank

	if _, err := svc.CreateVisit(context.Background(), actor, in); err != nil {
		t.Fatalf("blank visit-level vendor must be accepted as absent, got error: %v", err)
	}
	if repo.createdVisit.VendorNameOverride != nil {
		t.Errorf("stored VendorNameOverride = %q, want nil for a blank company", *repo.createdVisit.VendorNameOverride)
	}

	absent := validCreateInput()
	if _, err := svc.CreateVisit(context.Background(), actor, absent); err != nil {
		t.Fatalf("absent visit-level vendor must be accepted, got error: %v", err)
	}
	if repo.createdVisit.VendorNameOverride != nil {
		t.Errorf("stored VendorNameOverride = %q, want nil when nothing was typed", *repo.createdVisit.VendorNameOverride)
	}
}

// TestCreateVisit_RejectsOverlongVisitLevelVendorName pins the 120-rune cap
// on the trimmed visit-level company.
func TestCreateVisit_RejectsOverlongVisitLevelVendorName(t *testing.T) {
	repo := newFakeVisitRepo(t)
	svc := newTestService(repo, nil, testNow())
	actor := testActor(domain.RoleVendor, "vendor-1", "")

	tooLong := strings.Repeat("A", 121)
	in := validCreateInput()
	in.VendorName = &tooLong
	if _, err := svc.CreateVisit(context.Background(), actor, in); err == nil {
		t.Fatal("121-rune visit-level vendor must be rejected, got nil error")
	} else if !errors.Is(err, domain.ErrValidation) {
		t.Errorf("overlong vendor error = %v, want validation failure", err)
	}
	if repo.createCalls != 0 {
		t.Errorf("createCalls = %d, want 0", repo.createCalls)
	}

	exact := strings.Repeat("B", 120)
	ok := validCreateInput()
	ok.VendorName = &exact
	if _, err := svc.CreateVisit(context.Background(), actor, ok); err != nil {
		t.Fatalf("120-rune visit-level vendor must be accepted, got error: %v", err)
	}
}
