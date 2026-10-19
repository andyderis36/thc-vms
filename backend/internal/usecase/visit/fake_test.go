package visit

import (
	"context"
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
)

// fixedClock is a frozen domain.Clock so scheduling rules stay deterministic.
type fixedClock struct {
	now time.Time
}

func (c fixedClock) Now() time.Time {
	return c.now
}

func testNow() time.Time {
	return time.Date(2026, time.September, 25, 10, 0, 0, 0, time.UTC)
}

type updateCall struct {
	id        domain.UUID
	status    domain.VisitStatus
	changedBy domain.UUID
	notes     string
}

type rescheduleCall struct {
	id        domain.UUID
	start     time.Time
	end       time.Time
	changedBy domain.UUID
	reason    string
}

// fakeVisitRepo is a hand-written recording fake for domain.VisitRepository.
// onWrite fires on every write method so guard tests can fail on any
// repository write during a refused transition.
type fakeVisitRepo struct {
	t               *testing.T
	byID            map[domain.UUID]domain.VisitRequest
	byCode          map[string]domain.VisitRequest
	writes          int
	onWrite         func()
	updateCalls     []updateCall
	rescheduleCalls []rescheduleCall
	createCalls     int
	createdVisit    domain.VisitRequest
	createdVisitors []domain.Visitor
	createdPurposes []domain.UUID
	lastFilter      domain.VisitFilter
	listResult      []domain.VisitRequest
	listTotal       int64
}

func newFakeVisitRepo(t *testing.T) *fakeVisitRepo {
	t.Helper()
	return &fakeVisitRepo{
		t:      t,
		byID:   make(map[domain.UUID]domain.VisitRequest),
		byCode: make(map[string]domain.VisitRequest),
	}
}

func (f *fakeVisitRepo) recordWrite() {
	f.writes++
	if f.onWrite != nil {
		f.onWrite()
	}
}

func (f *fakeVisitRepo) Create(_ context.Context, visit domain.VisitRequest, visitors []domain.Visitor, purposeIDs []domain.UUID) (domain.VisitRequest, error) {
	f.recordWrite()
	f.createCalls++
	f.createdVisit = visit
	f.createdVisitors = visitors
	f.createdPurposes = purposeIDs
	if visit.ID == "" {
		visit.ID = domain.UUID("visit-generated")
	}
	return visit, nil
}

func (f *fakeVisitRepo) FindByID(_ context.Context, id domain.UUID) (domain.VisitRequest, error) {
	visit, ok := f.byID[id]
	if !ok {
		return domain.VisitRequest{}, domain.NotFoundEntity("Kunjungan")
	}
	return visit, nil
}

func (f *fakeVisitRepo) FindByVisitCode(_ context.Context, code string) (domain.VisitRequest, error) {
	visit, ok := f.byCode[code]
	if !ok {
		return domain.VisitRequest{}, domain.NotFoundEntity("Kunjungan")
	}
	return visit, nil
}

func (f *fakeVisitRepo) List(_ context.Context, filter domain.VisitFilter) ([]domain.VisitRequest, int64, error) {
	f.lastFilter = filter
	return f.listResult, f.listTotal, nil
}

func (f *fakeVisitRepo) UpdateStatus(_ context.Context, id domain.UUID, status domain.VisitStatus, changedBy domain.UUID, notes string) error {
	f.recordWrite()
	f.updateCalls = append(f.updateCalls, updateCall{id: id, status: status, changedBy: changedBy, notes: notes})
	visit, ok := f.byID[id]
	if !ok {
		return domain.NotFoundEntity("Kunjungan")
	}
	visit.Status = status
	f.byID[id] = visit
	return nil
}

func (f *fakeVisitRepo) Reschedule(_ context.Context, id domain.UUID, start time.Time, end time.Time, changedBy domain.UUID, reason string) error {
	f.recordWrite()
	f.rescheduleCalls = append(f.rescheduleCalls, rescheduleCall{id: id, start: start, end: end, changedBy: changedBy, reason: reason})
	visit, ok := f.byID[id]
	if !ok {
		return domain.NotFoundEntity("Kunjungan")
	}
	visit.StartDate = start
	visit.EndDate = end
	visit.Status = domain.VisitStatusRescheduled
	f.byID[id] = visit
	return nil
}

// DeleteVisit removes one visit from the fake roster, mirroring the
// PostgreSQL adapter's ErrNotFound on a missing id. The production cascade
// over the child tables needs no fake equivalent: the fake stores no child
// rows, so dropping the parent is already atomic.
func (f *fakeVisitRepo) DeleteVisit(_ context.Context, id domain.UUID) error {
	if _, ok := f.byID[id]; !ok {
		return domain.NotFoundEntity("Kunjungan")
	}
	delete(f.byID, id)
	return nil
}

// fakeMasterRepo is a hand-written fake for domain.MasterDataRepository.
type fakeMasterRepo struct {
	locations map[domain.UUID]domain.Location
}

func (f *fakeMasterRepo) ListLocations(_ context.Context, _ bool) ([]domain.Location, error) {
	return nil, nil
}

func (f *fakeMasterRepo) FindLocationByID(_ context.Context, id domain.UUID) (domain.Location, error) {
	loc, ok := f.locations[id]
	if !ok {
		return domain.Location{}, domain.NotFoundEntity("Lokasi")
	}
	return loc, nil
}

func (f *fakeMasterRepo) ListPurposes(_ context.Context, _ bool) ([]domain.Purpose, error) {
	return nil, nil
}

func newTestService(repo *fakeVisitRepo, master *fakeMasterRepo, now time.Time) *Service {
	if master == nil {
		master = &fakeMasterRepo{locations: make(map[domain.UUID]domain.Location)}
	}
	return NewService(repo, master, fixedClock{now: now}, nil, nil)
}

// fakeVendorRepo is a hand-written fake for domain.VendorRepository: the
// active company catalogue. ListVendors returns the active rows only, so a
// vendor absent from the list is unknown or blacklisted.
type fakeVendorRepo struct {
	vendors []domain.Vendor
}

func (f *fakeVendorRepo) ListVendors(_ context.Context) ([]domain.Vendor, error) {
	return f.vendors, nil
}

func (f *fakeVendorRepo) FindVendorName(_ context.Context, id domain.UUID) (string, error) {
	for _, v := range f.vendors {
		if v.ID == id {
			return v.Name, nil
		}
	}
	return "", domain.NotFoundEntity("Vendor")
}

// newTestServiceWithVendors wires the visit usecase to an active vendor
// catalogue for the create-vendor tests.
func newTestServiceWithVendors(repo *fakeVisitRepo, master *fakeMasterRepo, now time.Time, vendors []domain.Vendor) *Service {
	if master == nil {
		master = &fakeMasterRepo{locations: make(map[domain.UUID]domain.Location)}
	}
	return NewService(repo, master, fixedClock{now: now}, nil, &fakeVendorRepo{vendors: vendors})
}

func testActor(role domain.RoleName, id string, loc string) Actor {
	actor := Actor{ID: domain.UUID(id), Role: role}
	if loc != "" {
		locationID := domain.UUID(loc)
		actor.LocationID = &locationID
	}
	return actor
}

func seedVisit(repo *fakeVisitRepo, visit domain.VisitRequest) {
	repo.byID[visit.ID] = visit
	repo.byCode[visit.VisitID] = visit
}

func seedRequestedVisit(repo *fakeVisitRepo) domain.VisitRequest {
	visit := domain.VisitRequest{
		ID:            domain.UUID("visit-1"),
		VisitID:       "VST-0000000001",
		VendorUserID:  domain.UUID("vendor-1"),
		LocationID:    domain.UUID("loc-A"),
		StartDate:     time.Date(2026, time.October, 1, 9, 0, 0, 0, time.UTC),
		EndDate:       time.Date(2026, time.October, 1, 17, 0, 0, 0, time.UTC),
		Status:        domain.VisitStatusRequested,
		IsNDAAccepted: true,
	}
	seedVisit(repo, visit)
	return visit
}

func validCreateInput() CreateVisitInput {
	letter := "http://localhost:9000/thc-vms-bucket/assignment_letters/visit-1/spk.pdf"
	return CreateVisitInput{
		LocationID: domain.UUID("loc-A"),
		PurposeIDs: []domain.UUID{domain.UUID("pur-1"), domain.UUID("pur-2")},
		Visitors: []VisitorInput{
			{Name: "Andi", IDNumber: "ID123", Phone: "0811"},
			{Name: "Budi", IDNumber: "ID456", Phone: "0812"},
		},
		StartDate:     time.Date(2026, time.October, 1, 9, 0, 0, 0, time.UTC),
		EndDate:       time.Date(2026, time.October, 1, 17, 0, 0, 0, time.UTC),
		IsNDAAccepted: true,
		// SPK is mandatory on CREATE; every valid-input test carries one.
		AssignmentLetterURL: &letter,
	}
}
