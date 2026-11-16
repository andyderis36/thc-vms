package worker_test

import (
	"context"
	"fmt"
	"time"

	"thc-vms/backend/internal/domain"
)

// workerNow freezes the clock for every worker test: 2026-09-26 10:00 UTC.
var workerNow = time.Date(2026, time.September, 26, 10, 0, 0, 0, time.UTC)

type stubClock struct {
	now time.Time
}

func (c *stubClock) Now() time.Time { return c.now }

type stubSettingsLoader struct {
	snap domain.NotificationSettings
	err  error
}

func (s stubSettingsLoader) LoadNotificationSettings(_ context.Context) (domain.NotificationSettings, error) {
	return s.snap, s.err
}

type statusWrite struct {
	id        domain.UUID
	status    domain.VisitStatus
	changedBy domain.UUID
	notes     string
}

type fakeVisitRepo struct {
	visits     map[domain.UUID]domain.VisitRequest
	writes     []statusWrite
	updateErrs map[domain.UUID]error
	findErrs   map[domain.UUID]error
}

func newFakeVisitRepo(visits ...domain.VisitRequest) *fakeVisitRepo {
	f := &fakeVisitRepo{
		visits:     make(map[domain.UUID]domain.VisitRequest),
		updateErrs: make(map[domain.UUID]error),
		findErrs:   make(map[domain.UUID]error),
	}
	for _, v := range visits {
		f.visits[v.ID] = v
	}
	return f
}

func (f *fakeVisitRepo) Create(_ context.Context, visit domain.VisitRequest, _ []domain.Visitor, _ []domain.UUID) (domain.VisitRequest, error) {
	f.visits[visit.ID] = visit
	return visit, nil
}

func (f *fakeVisitRepo) FindByID(_ context.Context, id domain.UUID) (domain.VisitRequest, error) {
	if err, ok := f.findErrs[id]; ok {
		return domain.VisitRequest{}, err
	}
	v, ok := f.visits[id]
	if !ok {
		return domain.VisitRequest{}, fmt.Errorf("fakeVisitRepo: missing visit: %w", domain.ErrNotFound)
	}
	return v, nil
}

func (f *fakeVisitRepo) ListStatusHistory(_ context.Context, _ domain.UUID) ([]domain.StatusEvent, error) {
	return nil, nil
}

func (f *fakeVisitRepo) FindByVisitCode(_ context.Context, _ string) (domain.VisitRequest, error) {
	return domain.VisitRequest{}, fmt.Errorf("fakeVisitRepo: unimplemented: %w", domain.ErrNotFound)
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

// ListVisitorJabatan satisfies domain.VisitRepository; the worker never uses it.
func (f *fakeVisitRepo) ListVisitorJabatan(_ context.Context) ([]string, error) {
	return nil, nil
}

// UpdateVisitorContact satisfies domain.VisitRepository; the worker never uses it.
func (f *fakeVisitRepo) UpdateVisitorContact(_ context.Context, _, _ domain.UUID, _ string, _ bool) (domain.Visitor, error) {
	return domain.Visitor{}, fmt.Errorf("fakeVisitRepo: unimplemented: %w", domain.ErrNotFound)
}

// DeleteVisit removes one visit from the fake roster. The worker never calls
// it; it exists only so the fake keeps satisfying domain.VisitRepository.
func (f *fakeVisitRepo) DeleteVisit(_ context.Context, id domain.UUID) error {
	if _, ok := f.visits[id]; !ok {
		return fmt.Errorf("fakeVisitRepo: missing visit: %w", domain.ErrNotFound)
	}
	delete(f.visits, id)
	return nil
}

// AttachWorkPhoto satisfies domain.VisitRepository; the worker never uses it.
func (f *fakeVisitRepo) AttachWorkPhoto(_ context.Context, _ domain.UUID, _ domain.WorkPhotoKind, _ string, _ domain.UUID) (domain.WorkPhoto, bool, error) {
	return domain.WorkPhoto{}, false, fmt.Errorf("fakeVisitRepo: unimplemented: %w", domain.ErrNotFound)
}

// ListWorkPhotos satisfies domain.VisitRepository; the worker never uses it.
func (f *fakeVisitRepo) ListWorkPhotos(_ context.Context, _ domain.UUID) ([]domain.WorkPhoto, error) {
	return nil, nil
}

type fakeAutoRules struct {
	stale      []domain.VisitRequest
	noShow     []domain.VisitRequest
	overstayed []domain.VisitRequest
	reminders  []domain.VisitRequest
	staleErr   error
	noShowErr  error
	overErr    error
	remindErr  error
}

func (f *fakeAutoRules) FindStaleRequested(_ context.Context, _ time.Time) ([]domain.VisitRequest, error) {
	return f.stale, f.staleErr
}

func (f *fakeAutoRules) FindNoShow(_ context.Context, _ time.Time) ([]domain.VisitRequest, error) {
	return f.noShow, f.noShowErr
}

func (f *fakeAutoRules) FindOverstayedVisiting(_ context.Context, _ time.Time) ([]domain.VisitRequest, error) {
	return f.overstayed, f.overErr
}

func (f *fakeAutoRules) FindUpcomingApproved(_ context.Context, _, _ time.Time) ([]domain.VisitRequest, error) {
	return f.reminders, f.remindErr
}

type fakeCheckInOutRepo struct {
	checkIns map[domain.UUID]domain.CheckIn
}

func newFakeCheckInOutRepo(checkIns ...domain.CheckIn) *fakeCheckInOutRepo {
	f := &fakeCheckInOutRepo{checkIns: make(map[domain.UUID]domain.CheckIn)}
	for _, c := range checkIns {
		f.checkIns[c.VisitRequestID] = c
	}
	return f
}

func (f *fakeCheckInOutRepo) RecordCheckIn(_ context.Context, in domain.CheckIn) (domain.CheckIn, error) {
	if _, ok := f.checkIns[in.VisitRequestID]; ok {
		return domain.CheckIn{}, fmt.Errorf("fakeCheckInOutRepo: duplicate: %w", domain.ErrConflict)
	}
	f.checkIns[in.VisitRequestID] = in
	return in, nil
}

func (f *fakeCheckInOutRepo) RecordCheckOut(_ context.Context, in domain.CheckOut) (domain.CheckOut, error) {
	return in, nil
}

func (f *fakeCheckInOutRepo) FindCheckInByVisit(_ context.Context, visitID domain.UUID) (domain.CheckIn, error) {
	v, ok := f.checkIns[visitID]
	if !ok {
		return domain.CheckIn{}, fmt.Errorf("fakeCheckInOutRepo: missing: %w", domain.ErrNotFound)
	}
	return v, nil
}

func (f *fakeCheckInOutRepo) FindCheckOutByVisit(_ context.Context, _ domain.UUID) (domain.CheckOut, error) {
	return domain.CheckOut{}, fmt.Errorf("fakeCheckInOutRepo: missing: %w", domain.ErrNotFound)
}

type notifyWrite struct {
	visit domain.VisitRequest
	tpl   *domain.NotificationTemplate
}

type fakeNotificationRepo struct {
	writes         []notifyWrite
	insertErr      error
	recipients     []string
	recipientsErr  error
	staffTo        []string
	staffBcc       []string
	staffSplitErr  error
}

func (f *fakeNotificationRepo) List(_ context.Context, _ domain.NotificationFilter) ([]domain.Notification, int64, int64, error) {
	return nil, 0, 0, nil
}

func (f *fakeNotificationRepo) MarkRead(_ context.Context, _, _ domain.UUID) (bool, error) {
	return false, nil
}

func (f *fakeNotificationRepo) MarkAllRead(_ context.Context, _ domain.UUID) (int64, error) {
	return 0, nil
}

func (f *fakeNotificationRepo) InsertForVisit(_ context.Context, visit domain.VisitRequest, tpl *domain.NotificationTemplate, _ domain.NotificationSettings) error {
	if f.insertErr != nil {
		return f.insertErr
	}
	f.writes = append(f.writes, notifyWrite{visit: visit, tpl: tpl})
	return nil
}

// ResolveEmailRecipients returns the canned recipient set so reminder email
// tests stay hermetic; the SQL mirror is proven by the repository suite.
func (f *fakeNotificationRepo) ResolveEmailRecipients(_ context.Context, _ domain.VisitRequest, _ domain.NotificationAudience) ([]string, error) {
	if f.recipientsErr != nil {
		return nil, f.recipientsErr
	}
	return f.recipients, nil
}

// ResolveStaffEmailSplit returns the canned staff To/Bcc split so reminder
// staff-leg email tests stay hermetic; the SQL mirror is proven by the
// repository suite.
func (f *fakeNotificationRepo) ResolveStaffEmailSplit(_ context.Context, _ domain.VisitRequest) ([]string, []string, error) {
	if f.staffSplitErr != nil {
		return nil, nil, f.staffSplitErr
	}
	return f.staffTo, f.staffBcc, nil
}

func mkVisit(id domain.UUID, status domain.VisitStatus, createdAt, start, end time.Time) domain.VisitRequest {
	return domain.VisitRequest{
		ID:           id,
		VisitID:      "VST-" + string(id),
		VendorUserID: "vendor-1",
		LocationID:   "loc-A",
		StartDate:    start,
		EndDate:      end,
		Status:       status,
		CreatedAt:    createdAt,
		UpdatedAt:    createdAt,
	}
}
