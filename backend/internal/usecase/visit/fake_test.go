package visit

import (
	"context"
	"sort"
	"strings"
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
	// listCalls counts List invocations so refusal tests can prove the
	// repository query never ran.
	listCalls  int
	listResult []domain.VisitRequest
	listTotal  int64
	// jabatanRows holds raw stored Jabatan values (blanks and duplicates
	// included) so ListVisitorJabatan can model the SQL contract.
	jabatanRows []string
	jabatanErr  error
	// history is the fake status_history table keyed by visit id (nil = no
	// rows yet); historyErr reproduces a history-table outage.
	history    map[domain.UUID][]domain.StatusEvent
	historyErr error
	// workPhotos is the fake visit_work_photo table: visit id to kind slot.
	// AttachWorkPhoto upserts here so the replace-single-row tests can pin
	// the production UNIQUE (visit_request_id, kind) anchor.
	workPhotos map[domain.UUID]map[domain.WorkPhotoKind]domain.WorkPhoto
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

func (f *fakeVisitRepo) ListStatusHistory(_ context.Context, id domain.UUID) ([]domain.StatusEvent, error) {
	if f.historyErr != nil {
		return nil, f.historyErr
	}
	return f.history[id], nil
}

func (f *fakeVisitRepo) FindByVisitCode(_ context.Context, code string) (domain.VisitRequest, error) {
	visit, ok := f.byCode[code]
	if !ok {
		return domain.VisitRequest{}, domain.NotFoundEntity("Kunjungan")
	}
	return visit, nil
}

func (f *fakeVisitRepo) List(_ context.Context, filter domain.VisitFilter) ([]domain.VisitRequest, int64, error) {
	f.listCalls++
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

// UpdateVisitorContact mirrors the PostgreSQL adapter over the fake roster:
// a member outside visitID answers NotFoundEntity("Kunjungan") like a missing
// id, hiding cross-visit existence exactly like the production row lock.
func (f *fakeVisitRepo) UpdateVisitorContact(_ context.Context, visitID, visitorID domain.UUID, phone string, phoneEdited bool) (domain.Visitor, error) {
	f.recordWrite()
	visit, ok := f.byID[visitID]
	if !ok {
		return domain.Visitor{}, domain.NotFoundEntity("Kunjungan")
	}
	for i, v := range visit.Visitors {
		if v.ID != visitorID {
			continue
		}
		v.Phone = phone
		v.PhoneEdited = phoneEdited
		visit.Visitors[i] = v
		f.byID[visitID] = visit
		return v, nil
	}
	return domain.Visitor{}, domain.NotFoundEntity("Kunjungan")
}

// ListVisitorJabatan mirrors the domain.VisitRepository contract over the raw
// stored values: blank rows are dropped, duplicates collapse, the remainder is
// sorted ascending and the list is capped at 50.
func (f *fakeVisitRepo) ListVisitorJabatan(_ context.Context) ([]string, error) {
	if f.jabatanErr != nil {
		return nil, f.jabatanErr
	}
	seen := make(map[string]struct{}, len(f.jabatanRows))
	values := make([]string, 0, len(f.jabatanRows))
	for _, raw := range f.jabatanRows {
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		values = append(values, trimmed)
	}
	sort.Strings(values)
	if len(values) > 50 {
		values = values[:50]
	}
	return values, nil
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

// AttachWorkPhoto mirrors the PostgreSQL adapter over the fake proof table:
// a missing visit answers NotFoundEntity("Kunjungan"), any status but
// visiting answers the 409 conflict, and the write upserts on
// (visit, kind) so a re-attach replaces the single row instead of adding
// one. The returned bool reports create (true) versus replace (false),
// exactly like the production 201-vs-200 answer.
func (f *fakeVisitRepo) AttachWorkPhoto(_ context.Context, visitID domain.UUID, kind domain.WorkPhotoKind, url string, uploadedBy domain.UUID) (domain.WorkPhoto, bool, error) {
	visit, ok := f.byID[visitID]
	if !ok {
		return domain.WorkPhoto{}, false, domain.NotFoundEntity("Kunjungan")
	}
	if visit.Status != domain.VisitStatusVisiting {
		return domain.WorkPhoto{}, false, domain.Conflict("Bukti pengerjaan hanya dapat dilampirkan saat kunjungan sedang berlangsung.")
	}
	f.recordWrite()
	if f.workPhotos == nil {
		f.workPhotos = make(map[domain.UUID]map[domain.WorkPhotoKind]domain.WorkPhoto)
	}
	slots, ok := f.workPhotos[visitID]
	if !ok {
		slots = make(map[domain.WorkPhotoKind]domain.WorkPhoto)
		f.workPhotos[visitID] = slots
	}
	_, created := slots[kind]
	photo := domain.WorkPhoto{
		VisitRequestID: visitID,
		Kind:           kind,
		URL:            url,
		UploadedAt:     testNow(),
	}
	if uploadedBy != "" {
		by := uploadedBy
		photo.UploadedBy = &by
	}
	slots[kind] = photo
	return photo, !created, nil
}

// ListWorkPhotos mirrors the PostgreSQL adapter over the fake proof table: a
// missing visit answers NotFoundEntity("Kunjungan"), a visit without proofs
// yields an empty slice.
func (f *fakeVisitRepo) ListWorkPhotos(_ context.Context, visitID domain.UUID) ([]domain.WorkPhoto, error) {
	if _, ok := f.byID[visitID]; !ok {
		return nil, domain.NotFoundEntity("Kunjungan")
	}
	out := make([]domain.WorkPhoto, 0, 2)
	for _, kind := range []domain.WorkPhotoKind{domain.WorkPhotoAfter, domain.WorkPhotoBefore} {
		if photo, ok := f.workPhotos[visitID][kind]; ok {
			out = append(out, photo)
		}
	}
	return out, nil
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

// fakeAccountLookup is a hand-written fake for domain.UserAccountLookup: the
// create path resolves a chosen vendor_user_id to its role and status.
type fakeAccountLookup struct {
	accounts map[domain.UUID]domain.ManagedUser
	err      error
	calls    int
}

func (f *fakeAccountLookup) FindManagedByID(_ context.Context, id domain.UUID) (domain.ManagedUser, error) {
	f.calls++
	if f.err != nil {
		return domain.ManagedUser{}, f.err
	}
	account, ok := f.accounts[id]
	if !ok {
		return domain.ManagedUser{}, domain.NotFoundEntity("Akun")
	}
	return account, nil
}

// newTestServiceWithAccounts wires the create path to the account directory a
// chosen vendor_user_id is validated against.
func newTestServiceWithAccounts(repo *fakeVisitRepo, accounts domain.UserAccountLookup) *Service {
	return newTestService(repo, nil, testNow()).WithAccountLookup(accounts)
}

// visitVendorAccount builds the account-directory projection of one vendor
// account with the given lifecycle status.
func visitVendorAccount(id string, status domain.UserStatus) domain.ManagedUser {
	return domain.ManagedUser{
		User: domain.User{ID: domain.UUID(id), Status: status, Type: domain.UserTypeExternal},
		Role: domain.RoleVendor,
	}
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
			{Name: "Andi", IDNumber: "ID123", Phone: "0812345678"},
			{Name: "Budi", IDNumber: "ID456", Phone: "0812345679"},
		},
		StartDate:     time.Date(2026, time.October, 1, 9, 0, 0, 0, time.UTC),
		EndDate:       time.Date(2026, time.October, 1, 17, 0, 0, 0, time.UTC),
		IsNDAAccepted: true,
		// SPK is mandatory on CREATE; every valid-input test carries one.
		AssignmentLetterURL: &letter,
	}
}
