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
func TestGetVisit_SecurityRestrictedToToday(t *testing.T) {
	master := &fakeMasterRepo{locations: map[domain.UUID]domain.Location{
		domain.UUID("loc-A"): {ID: domain.UUID("loc-A"), Name: "POP A", Timezone: domain.TimezoneWIB},
	}}

	today := domain.VisitRequest{
		ID:         domain.UUID("visit-today"),
		VisitID:    "VST-TODAY00001",
		PICUserID:  domain.UUID("pic-1"),
		LocationID: domain.UUID("loc-A"),
		StartDate:  time.Date(2026, time.September, 25, 9, 0, 0, 0, wibZone()),
		EndDate:    time.Date(2026, time.September, 25, 18, 0, 0, 0, wibZone()),
		Status:     domain.VisitStatusApproved,
	}
	stale := domain.VisitRequest{
		ID:         domain.UUID("visit-stale"),
		VisitID:    "VST-STALE00001",
		PICUserID:  domain.UUID("pic-1"),
		LocationID: domain.UUID("loc-A"),
		StartDate:  time.Date(2026, time.September, 20, 9, 0, 0, 0, wibZone()),
		EndDate:    time.Date(2026, time.September, 20, 18, 0, 0, 0, wibZone()),
		Status:     domain.VisitStatusApproved,
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

	if _, err := svc.GetVisit(context.Background(), guard, "VST-STALE00001"); err == nil {
		t.Fatal("stale visit must be hidden from security, got nil error")
	} else if !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("stale visit error = %v, want not found", err)
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

	otherVendor := testActor(domain.RoleVendor, "pic-9", "")
	if _, err := svc.GetVisit(context.Background(), otherVendor, "visit-1"); err == nil {
		t.Error("other vendor read must be refused, got nil error")
	} else if !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("other vendor read error = %v, want not found", err)
	}

	owner := testActor(domain.RoleVendor, "pic-1", "")
	if _, err := svc.GetVisit(context.Background(), owner, "visit-1"); err != nil {
		t.Errorf("owning vendor read returned error: %v", err)
	}
}
