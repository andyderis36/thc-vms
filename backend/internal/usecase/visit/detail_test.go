package visit

import (
	"context"
	"errors"
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
)

func wibZone() *time.Location {
	return time.FixedZone("WIB", 7*3600)
}

// now is 2026-09-25 10:00 UTC = 17:00 WIB on the same calendar day.
// A guard opens ANY visit in its own branch regardless of date: today's,
// past, and future-dated approved visits all succeed with full detail.
// Only cross-branch reads stay refused.
func TestGetVisit_SecurityOpensAnyBranchVisit(t *testing.T) {
	master := &fakeMasterRepo{locations: map[domain.UUID]domain.Location{
		domain.UUID("loc-A"): {ID: domain.UUID("loc-A"), Name: "POP A", Timezone: domain.TimezoneWIB},
	}}

	today := domain.VisitRequest{
		ID:           domain.UUID("visit-today"),
		VisitID:      "VST-TODAY00001",
		VendorUserID: domain.UUID("vendor-1"),
		LocationID:   domain.UUID("loc-A"),
		StartDate:    time.Date(2026, time.September, 25, 9, 0, 0, 0, wibZone()),
		EndDate:      time.Date(2026, time.September, 25, 18, 0, 0, 0, wibZone()),
		Status:       domain.VisitStatusApproved,
	}
	stale := domain.VisitRequest{
		ID:           domain.UUID("visit-stale"),
		VisitID:      "VST-STALE00001",
		VendorUserID: domain.UUID("vendor-1"),
		LocationID:   domain.UUID("loc-A"),
		StartDate:    time.Date(2026, time.September, 20, 9, 0, 0, 0, wibZone()),
		EndDate:      time.Date(2026, time.September, 20, 18, 0, 0, 0, wibZone()),
		Status:       domain.VisitStatusCompleted,
	}

	repo := newFakeVisitRepo(t)
	seedVisit(repo, today)
	seedVisit(repo, stale)
	svc := newTestService(repo, master, testNow())
	guard := testActor(domain.RoleSecurity, "sec-1", "loc-A")

	got, err := svc.GetVisit(context.Background(), guard, "VST-TODAY00001")
	if err != nil {
		t.Fatalf("today visit must be visible, got error: %v", err)
	}
	if got.ID != domain.UUID("visit-today") {
		t.Errorf("ID = %q, want visit-today", got.ID)
	}

	got, err = svc.GetVisit(context.Background(), guard, "VST-STALE00001")
	if err != nil {
		t.Fatalf("past branch visit must be visible, got error: %v", err)
	}
	if got.ID != domain.UUID("visit-stale") {
		t.Errorf("ID = %q, want visit-stale", got.ID)
	}

	foreign := testActor(domain.RoleSecurity, "sec-9", "loc-B")
	if _, err := svc.GetVisit(context.Background(), foreign, "VST-TODAY00001"); err == nil {
		t.Error("cross-branch security read must be refused, got nil error")
	} else if !errors.Is(err, domain.ErrForbiddenBranch) {
		t.Errorf("cross-branch read error = %v, want forbidden branch", err)
	}
}

// A security guard opening a future-dated approved visit in its own branch
// (the /gate queue-card tap: GET /visits/VST-...) succeeds with full detail:
// vendor display name, visitor rows, and stored file references.
func TestGetVisit_SecurityOpensFutureApprovedVisit(t *testing.T) {
	master := &fakeMasterRepo{locations: map[domain.UUID]domain.Location{
		domain.UUID("loc-A"): {ID: domain.UUID("loc-A"), Name: "POP A", Timezone: domain.TimezoneWIB},
	}}
	letter := presignTestBase + "/assignment_letters/visit-future/spk.pdf"
	idCard := presignTestBase + "/id_cards/visitor-1/ktp.jpg"
	photo := presignTestBase + "/id_cards/visitor-1/selfie.jpg"
	future := domain.VisitRequest{
		ID:                  domain.UUID("visit-future"),
		VisitID:             "VST-3523808258",
		VendorUserID:        domain.UUID("vendor-1"),
		LocationID:          domain.UUID("loc-A"),
		StartDate:           time.Date(2026, time.October, 5, 9, 0, 0, 0, wibZone()),
		EndDate:             time.Date(2026, time.October, 5, 18, 0, 0, 0, wibZone()),
		Status:              domain.VisitStatusApproved,
		VendorName:          "PT Subkon Mandiri",
		AssignmentLetterURL: &letter,
		Visitors: []domain.Visitor{
			{ID: domain.UUID("visitor-1"), Name: "Andi", IDCardPhotoURL: &idCard, PhotoURL: &photo},
		},
	}

	repo := newFakeVisitRepo(t)
	seedVisit(repo, future)
	svc := newTestService(repo, master, testNow()).WithFileLinks(&fakeFileStorage{}, 0)
	guard := testActor(domain.RoleSecurity, "sec-1", "loc-A")

	got, err := svc.GetVisit(context.Background(), guard, "VST-3523808258")
	if err != nil {
		t.Fatalf("future approved branch visit must be visible, got error: %v", err)
	}
	if got.ID != domain.UUID("visit-future") {
		t.Errorf("ID = %q, want visit-future", got.ID)
	}
	if got.VendorName != "PT Subkon Mandiri" {
		t.Errorf("VendorName = %q, want PT Subkon Mandiri", got.VendorName)
	}
	if len(got.Visitors) != 1 || got.Visitors[0].Name != "Andi" {
		t.Fatalf("Visitors = %+v, want one row for Andi", got.Visitors)
	}
	if got.AssignmentLetterURL == nil || *got.AssignmentLetterURL == "" {
		t.Error("AssignmentLetterURL must be present on the detail response")
	}
	if got.Visitors[0].PhotoURL == nil || *got.Visitors[0].PhotoURL == "" {
		t.Error("visitor PhotoURL must be present on the detail response")
	}
}

func TestGetVisit_ReadScope(t *testing.T) {
	master := &fakeMasterRepo{locations: map[domain.UUID]domain.Location{
		domain.UUID("loc-A"): {ID: domain.UUID("loc-A"), Name: "POP A", Timezone: domain.TimezoneWIB},
	}}
	repo := newFakeVisitRepo(t)
	seedRequestedVisit(repo)
	svc := newTestService(repo, master, testNow())

	adminOther := testActor(domain.RoleAdmin, "admin-9", "loc-B")
	if _, err := svc.GetVisit(context.Background(), adminOther, "visit-1"); err == nil {
		t.Error("cross-branch admin read must be refused, got nil error")
	} else if !errors.Is(err, domain.ErrForbiddenBranch) {
		t.Errorf("cross-branch read error = %v, want forbidden branch", err)
	}

	otherVendor := testActor(domain.RoleVendor, "vendor-9", "")
	if _, err := svc.GetVisit(context.Background(), otherVendor, "visit-1"); err == nil {
		t.Error("other vendor read must be refused, got nil error")
	} else if !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("other vendor read error = %v, want not found", err)
	}

	owner := testActor(domain.RoleVendor, "vendor-1", "")
	if _, err := svc.GetVisit(context.Background(), owner, "visit-1"); err != nil {
		t.Errorf("owning vendor read returned error: %v", err)
	}
}
