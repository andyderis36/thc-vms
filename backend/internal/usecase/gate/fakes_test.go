package gate_test

import (
	"context"
	"fmt"
	"time"

	"thc-vms/backend/internal/domain"
)

// fixedNow freezes the clock for every gate test: 2026-09-26 10:00 UTC.
var fixedNow = time.Date(2026, time.September, 26, 10, 0, 0, 0, time.UTC)

type stubClock struct {
	now time.Time
}

func (c *stubClock) Now() time.Time { return c.now }

func uuidPtr(id domain.UUID) *domain.UUID { return &id }

type statusWrite struct {
	id        domain.UUID
	status    domain.VisitStatus
	changedBy domain.UUID
	notes     string
}

type fakeVisitRepo struct {
	visits     map[domain.UUID]domain.VisitRequest
	codes      map[string]domain.UUID
	writes     []statusWrite
	findErr    error
	updateErrs map[domain.UUID]error
}

func newFakeVisitRepo(visits ...domain.VisitRequest) *fakeVisitRepo {
	f := &fakeVisitRepo{
		visits:     make(map[domain.UUID]domain.VisitRequest),
		codes:      make(map[string]domain.UUID),
		updateErrs: make(map[domain.UUID]error),
	}
	for _, v := range visits {
		f.visits[v.ID] = v
		f.codes[v.VisitID] = v.ID
	}
	return f
}

func (f *fakeVisitRepo) Create(_ context.Context, visit domain.VisitRequest, _ []domain.Visitor, _ []domain.UUID) (domain.VisitRequest, error) {
	f.visits[visit.ID] = visit
	return visit, nil
}

func (f *fakeVisitRepo) FindByID(_ context.Context, id domain.UUID) (domain.VisitRequest, error) {
	if f.findErr != nil {
		return domain.VisitRequest{}, f.findErr
	}
	v, ok := f.visits[id]
	if !ok {
		return domain.VisitRequest{}, fmt.Errorf("fakeVisitRepo: missing visit: %w", domain.ErrNotFound)
	}
	return v, nil
}

func (f *fakeVisitRepo) FindByVisitCode(_ context.Context, code string) (domain.VisitRequest, error) {
	if f.findErr != nil {
		return domain.VisitRequest{}, f.findErr
	}
	id, ok := f.codes[code]
	if !ok {
		return domain.VisitRequest{}, fmt.Errorf("fakeVisitRepo: missing visit code: %w", domain.ErrNotFound)
	}
	return f.visits[id], nil
}

func (f *fakeVisitRepo) List(_ context.Context, _ domain.VisitFilter) ([]domain.VisitRequest, int64, error) {
	return nil, 0, nil
}

func (f *fakeVisitRepo) UpdateStatus(_ context.Context, id domain.UUID, status domain.VisitStatus, changedBy domain.UUID, notes string) error {
	if err, ok := f.updateErrs[id]; ok {
		return err
	}
	v, ok := f.visits[id]
	if !ok {
		return fmt.Errorf("fakeVisitRepo: missing visit: %w", domain.ErrNotFound)
	}
	v.Status = status
	f.visits[id] = v
	f.writes = append(f.writes, statusWrite{id: id, status: status, changedBy: changedBy, notes: notes})
	return nil
}

func (f *fakeVisitRepo) Reschedule(_ context.Context, _ domain.UUID, _, _ time.Time, _ domain.UUID, _ string) error {
	return nil
}

type fakeCheckInOutRepo struct {
	checkIns    map[domain.UUID]domain.CheckIn
	checkOuts   map[domain.UUID]domain.CheckOut
	checkInErr  error
	checkOutErr error
}

func newFakeCheckInOutRepo() *fakeCheckInOutRepo {
	return &fakeCheckInOutRepo{
		checkIns:  make(map[domain.UUID]domain.CheckIn),
		checkOuts: make(map[domain.UUID]domain.CheckOut),
	}
}

func (f *fakeCheckInOutRepo) RecordCheckIn(_ context.Context, in domain.CheckIn) (domain.CheckIn, error) {
	if f.checkInErr != nil {
		return domain.CheckIn{}, f.checkInErr
	}
	if _, ok := f.checkIns[in.VisitRequestID]; ok {
		return domain.CheckIn{}, fmt.Errorf("fakeCheckInOutRepo: duplicate check-in: %w", domain.ErrConflict)
	}
	stored := in
	stored.ID = domain.UUID("checkin-" + string(in.VisitRequestID))
	f.checkIns[in.VisitRequestID] = stored
	return stored, nil
}

func (f *fakeCheckInOutRepo) RecordCheckOut(_ context.Context, in domain.CheckOut) (domain.CheckOut, error) {
	if f.checkOutErr != nil {
		return domain.CheckOut{}, f.checkOutErr
	}
	if _, ok := f.checkOuts[in.VisitRequestID]; ok {
		return domain.CheckOut{}, fmt.Errorf("fakeCheckInOutRepo: duplicate check-out: %w", domain.ErrConflict)
	}
	stored := in
	stored.ID = domain.UUID("checkout-" + string(in.VisitRequestID))
	f.checkOuts[in.VisitRequestID] = stored
	return stored, nil
}

func (f *fakeCheckInOutRepo) FindCheckInByVisit(_ context.Context, visitID domain.UUID) (domain.CheckIn, error) {
	v, ok := f.checkIns[visitID]
	if !ok {
		return domain.CheckIn{}, fmt.Errorf("fakeCheckInOutRepo: missing check-in: %w", domain.ErrNotFound)
	}
	return v, nil
}

func (f *fakeCheckInOutRepo) FindCheckOutByVisit(_ context.Context, visitID domain.UUID) (domain.CheckOut, error) {
	v, ok := f.checkOuts[visitID]
	if !ok {
		return domain.CheckOut{}, fmt.Errorf("fakeCheckInOutRepo: missing check-out: %w", domain.ErrNotFound)
	}
	return v, nil
}

// visitFixture builds an approved visit on loc-A with a window around fixedNow.
func visitFixture(id domain.UUID, status domain.VisitStatus, start, end time.Time) domain.VisitRequest {
	return domain.VisitRequest{
		ID:         id,
		VisitID:    "VST-" + string(id),
		PICUserID:  "pic-1",
		LocationID: "loc-A",
		StartDate:  start,
		EndDate:    end,
		Status:     status,
		CreatedAt:  fixedNow.Add(-time.Hour),
		UpdatedAt:  fixedNow.Add(-time.Hour),
	}
}

// openWindow returns a visit window that contains fixedNow: [now-1h, now+1h].
func openWindow() (time.Time, time.Time) {
	return fixedNow.Add(-time.Hour), fixedNow.Add(time.Hour)
}
