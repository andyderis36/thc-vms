package visit

import (
	"context"
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
)

// fakeCheckInOut is a hand-written fake for domain.CheckInOutRepository used
// only by the gate-enrichment tests: it serves one canned check-in/out pair
// or reports "no record yet" via domain.ErrNotFound.
type fakeCheckInOut struct {
	checkIn  domain.CheckIn
	checkOut domain.CheckOut
	hasIn    bool
	hasOut   bool
}

func (f *fakeCheckInOut) RecordCheckIn(_ context.Context, in domain.CheckIn) (domain.CheckIn, error) {
	return domain.CheckIn{}, nil
}

func (f *fakeCheckInOut) RecordCheckOut(_ context.Context, in domain.CheckOut) (domain.CheckOut, error) {
	return domain.CheckOut{}, nil
}

func (f *fakeCheckInOut) FindCheckInByVisit(_ context.Context, _ domain.UUID) (domain.CheckIn, error) {
	if !f.hasIn {
		return domain.CheckIn{}, domain.ErrNotFound
	}
	return f.checkIn, nil
}

func (f *fakeCheckInOut) FindCheckOutByVisit(_ context.Context, _ domain.UUID) (domain.CheckOut, error) {
	if !f.hasOut {
		return domain.CheckOut{}, domain.ErrNotFound
	}
	return f.checkOut, nil
}

func gateMaster() *fakeMasterRepo {
	return &fakeMasterRepo{locations: map[domain.UUID]domain.Location{
		domain.UUID("loc-A"): {ID: domain.UUID("loc-A"), Name: "POP A", Timezone: domain.TimezoneWIB},
	}}
}

// A visiting single-GET carries both gate timestamps plus the acting staff id;
// a requested one carries none.
func TestGetVisit_EnrichesGateTimes(t *testing.T) {
	inAt := time.Date(2026, time.September, 26, 7, 30, 0, 0, time.UTC)
	outAt := time.Date(2026, time.September, 26, 15, 5, 0, 0, time.UTC)
	gates := &fakeCheckInOut{
		checkIn:  domain.CheckIn{VisitRequestID: domain.UUID("visit-1"), CheckedInAt: inAt, CheckedInBy: domain.UUID("sec-1")},
		checkOut: domain.CheckOut{VisitRequestID: domain.UUID("visit-1"), CheckedOutAt: outAt, CheckedOutBy: domain.UUID("sec-1")},
		hasIn:    true,
		hasOut:   true,
	}

	repo := newFakeVisitRepo(t)
	visit := seedRequestedVisit(repo)
	visit.Status = domain.VisitStatusVisiting
	seedVisit(repo, visit)
	svc := NewService(repo, gateMaster(), fixedClock{now: testNow()}, gates, nil)

	got, err := svc.GetVisit(context.Background(), testActor(domain.RoleAdmin, "admin-1", "loc-A"), "visit-1")
	if err != nil {
		t.Fatalf("GetVisit returned error: %v", err)
	}
	if got.CheckInAt == nil || !got.CheckInAt.Equal(inAt) {
		t.Errorf("CheckInAt = %v, want %v", got.CheckInAt, inAt)
	}
	if got.CheckOutAt == nil || !got.CheckOutAt.Equal(outAt) {
		t.Errorf("CheckOutAt = %v, want %v", got.CheckOutAt, outAt)
	}
	if got.CheckedInBy == nil || *got.CheckedInBy != domain.UUID("sec-1") {
		t.Errorf("CheckedInBy = %v, want sec-1", got.CheckedInBy)
	}
}

// Before any gate record exists every enrichment pointer stays nil, and a nil
// check-in port (legacy construction) degrades the same way.
func TestGetVisit_NoGateRecordLeavesNilTimes(t *testing.T) {
	for name, gates := range map[string]domain.CheckInOutRepository{
		"empty table": &fakeCheckInOut{},
		"nil port":    nil,
	} {
		t.Run(name, func(t *testing.T) {
			repo := newFakeVisitRepo(t)
			seedRequestedVisit(repo)
			svc := NewService(repo, gateMaster(), fixedClock{now: testNow()}, gates, nil)

			got, err := svc.GetVisit(context.Background(), testActor(domain.RoleAdmin, "admin-1", "loc-A"), "visit-1")
			if err != nil {
				t.Fatalf("GetVisit returned error: %v", err)
			}
			if got.CheckInAt != nil || got.CheckOutAt != nil || got.CheckedInBy != nil {
				t.Errorf("gate pointers must be nil, got in=%v out=%v by=%v",
					got.CheckInAt, got.CheckOutAt, got.CheckedInBy)
			}
		})
	}
}

// Enrichment runs only AFTER the read scope passes: a cross-branch admin must
// still be refused, never served another branch's gate times.
func TestGetVisit_EnrichmentRespectsBranchScope(t *testing.T) {
	repo := newFakeVisitRepo(t)
	seedRequestedVisit(repo)
	svc := NewService(repo, gateMaster(), fixedClock{now: testNow()}, &fakeCheckInOut{}, nil)

	other := testActor(domain.RoleAdmin, "admin-9", "loc-B")
	if _, err := svc.GetVisit(context.Background(), other, "visit-1"); err == nil {
		t.Error("cross-branch admin read must be refused, got nil error")
	}
}
