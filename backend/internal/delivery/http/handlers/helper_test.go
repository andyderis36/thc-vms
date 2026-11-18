package handlers_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/handlers"
	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/gate"
	"thc-vms/backend/internal/usecase/visit"
)

func init() {
	gin.SetMode(gin.TestMode)
}

// envelope mirrors the wire shape from response/envelope.go.
type envelope struct {
	Success bool            `json:"success"`
	Data    json.RawMessage `json:"data"`
	Error   *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// withActor injects the documented gin-context identity the handlers read.
func withActor(role domain.RoleName, loc string) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Set(handlers.CtxUserID, "actor-1")
		c.Set(handlers.CtxUserRole, string(role))
		if loc != "" {
			c.Set(handlers.CtxLocationID, loc)
		}
		c.Next()
	}
}

func serve(engine *gin.Engine, method, path string, body []byte, contentType string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, req)
	return rec
}

func serveJSON(engine *gin.Engine, method, path string, payload string) *httptest.ResponseRecorder {
	return serve(engine, method, path, []byte(payload), "application/json")
}

func decodeEnvelope(t *testing.T, rec *httptest.ResponseRecorder) envelope {
	t.Helper()
	var env envelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("response is not a valid envelope: %v: %q", err, rec.Body.String())
	}
	return env
}

func decodeData[T any](t *testing.T, env envelope) T {
	t.Helper()
	var out T
	if err := json.Unmarshal(env.Data, &out); err != nil {
		t.Fatalf("data does not decode: %v: %q", err, string(env.Data))
	}
	return out
}

// cannedVisit is the visit every fake serves unless a test overrides it. It
// carries one rostered technician with a selfie plus the resolved vendor name
// so the list/get/contract tests pin the photo_url and vendor_name members,
// including the per-technician vendor_id/vendor_name pair. Location name/type
// ride along so the list/get tests pin the Fasilitas column (location member).
// Vendor user name/email ride along so the list/get tests pin kartu Informasi
// Kunjungan (vendor_user + legacy pic_user member).
func cannedVisit() domain.VisitRequest {
	start := time.Date(2026, time.October, 1, 9, 0, 0, 0, time.UTC)
	end := time.Date(2026, time.October, 1, 17, 0, 0, 0, time.UTC)
	notes := "splicing FO"
	letter := "http://localhost:9000/thc-vms-bucket/assignment_letters/visit-1/spk.pdf"
	selfie := "http://localhost:9000/thc-vms-bucket/id_card/visit-1/selfie.jpg"
	return domain.VisitRequest{
		ID:                  "visit-1",
		VisitID:             "VST-0000000001",
		VendorUserID:        "vendor-1",
		VendorUserName:      "Dimas Prasetyo",
		VendorUserEmail:     "dimas@vendor.example",
		VendorID:            "vendor-1",
		VendorName:          "PT Lintas Fiber",
		LocationID:          "loc-A",
		LocationName:        "POP Tebet",
		LocationType:        domain.LocationPOP,
		StartDate:           start,
		EndDate:             end,
		Status:              domain.VisitStatusApproved,
		AssignmentLetterURL: &letter,
		IsNDAAccepted:       true,
		Notes:               &notes,
		CreatedAt:           time.Date(2026, time.September, 20, 10, 0, 0, 0, time.UTC),
		Visitors: []domain.Visitor{
			{
				ID: "visitor-1", VisitRequestID: "visit-1",
				Name: "Andi", IDNumber: "ID123", Phone: "0811", PhotoURL: &selfie,
				VendorID: "vendor-1", VendorName: "PT Lintas Fiber",
				Jabatan: strPtr("Teknisi"),
			},
		},
	}
}

// fakeVisitService is a hand-written fake for handlers.VisitService.
type fakeVisitService struct {
	listItems  []domain.VisitRequest
	listTotal  int64
	listErr    error
	lastListIn visit.ListVisitsInput

	created      domain.VisitRequest
	createErr    error
	lastCreateIn visit.CreateVisitInput

	visitByKey map[string]domain.VisitRequest
	getErr     error
	lastGetKey string

	approveErr    error
	lastApproveID domain.UUID
	lastNote      string

	rejectErr    error
	lastRejectID domain.UUID
	lastReason   string

	cancelErr    error
	lastCancelID domain.UUID
	lastCancelNo string

	rescheduleErr    error
	lastRescheduleID domain.UUID
	lastStart        time.Time
	lastEnd          time.Time
	lastResReason    string

	memberErr       error
	lastMemberVisit domain.UUID
	lastMemberID    domain.UUID
	lastMemberPhone *string
	lastMemberIDNo  *string
	updatedMember   *domain.Visitor

	jabatan    []string
	jabatanErr error

	vendorSuggestions    []domain.VendorSuggestion
	vendorSuggestionsErr error
	lastVendorQuery      string

	memberSuggestions    []domain.MemberSuggestion
	memberSuggestionsErr error
	lastMemberIn         visit.MemberSuggestionsInput

	memberDetail      domain.MemberSuggestionDetail
	memberDetailErr   error
	lastMemberVisitor domain.UUID

	attachPhoto    domain.WorkPhoto
	attachCreated  bool
	attachReplace  bool
	attachErr      error
	lastAttachID   domain.UUID
	lastAttachKind string
	lastAttachURL  string
}

func (f *fakeVisitService) ListVisits(_ context.Context, _ visit.Actor, in visit.ListVisitsInput) ([]domain.VisitRequest, int64, error) {
	f.lastListIn = in
	if f.listErr != nil {
		return nil, 0, f.listErr
	}
	return f.listItems, f.listTotal, nil
}

func (f *fakeVisitService) CreateVisit(_ context.Context, _ visit.Actor, in visit.CreateVisitInput) (domain.VisitRequest, error) {
	f.lastCreateIn = in
	if f.createErr != nil {
		return domain.VisitRequest{}, f.createErr
	}
	if f.created.ID != "" {
		return f.created, nil
	}
	return cannedVisit(), nil
}

func (f *fakeVisitService) GetVisit(_ context.Context, _ visit.Actor, key string) (domain.VisitRequest, error) {
	f.lastGetKey = key
	if f.getErr != nil {
		return domain.VisitRequest{}, f.getErr
	}
	if v, ok := f.visitByKey[key]; ok {
		return v, nil
	}
	// A created visit re-reads itself through the GET path in production, so
	// the fallback serves the created row when a test sets no explicit GET
	// row. An explicit visitByKey entry still wins (enriched re-read case).
	if f.created.ID != "" {
		return f.created, nil
	}
	return cannedVisit(), nil
}

func (f *fakeVisitService) Approve(_ context.Context, _ visit.Actor, id domain.UUID, note string) error {
	f.lastApproveID = id
	f.lastNote = note
	return f.approveErr
}

func (f *fakeVisitService) Reject(_ context.Context, _ visit.Actor, id domain.UUID, reason string) error {
	f.lastRejectID = id
	f.lastReason = reason
	return f.rejectErr
}

func (f *fakeVisitService) Cancel(_ context.Context, _ visit.Actor, id domain.UUID, note string) error {
	f.lastCancelID = id
	f.lastCancelNo = note
	return f.cancelErr
}

func (f *fakeVisitService) Reschedule(_ context.Context, _ visit.Actor, id domain.UUID, start, end time.Time, reason string) error {
	f.lastRescheduleID = id
	f.lastStart = start
	f.lastEnd = end
	f.lastResReason = reason
	return f.rescheduleErr
}

func (f *fakeVisitService) ListJabatan(_ context.Context) ([]string, error) {
	if f.jabatanErr != nil {
		return nil, f.jabatanErr
	}
	return f.jabatan, nil
}

func (f *fakeVisitService) ListVendorSuggestions(_ context.Context, _ visit.Actor, query string) ([]domain.VendorSuggestion, error) {
	f.lastVendorQuery = query
	if f.vendorSuggestionsErr != nil {
		return nil, f.vendorSuggestionsErr
	}
	return f.vendorSuggestions, nil
}

func (f *fakeVisitService) ListMemberSuggestions(_ context.Context, _ visit.Actor, in visit.MemberSuggestionsInput) ([]domain.MemberSuggestion, error) {
	f.lastMemberIn = in
	if f.memberSuggestionsErr != nil {
		return nil, f.memberSuggestionsErr
	}
	return f.memberSuggestions, nil
}

func (f *fakeVisitService) GetMemberSuggestion(_ context.Context, _ visit.Actor, visitorID domain.UUID) (domain.MemberSuggestionDetail, error) {
	f.lastMemberVisitor = visitorID
	if f.memberDetailErr != nil {
		return domain.MemberSuggestionDetail{}, f.memberDetailErr
	}
	return f.memberDetail, nil
}

func (f *fakeVisitService) AttachWorkPhoto(_ context.Context, _ visit.Actor, id domain.UUID, kind, url string, _ *domain.UUID) (domain.WorkPhoto, bool, error) {
	f.lastAttachID = id
	f.lastAttachKind = kind
	f.lastAttachURL = url
	if f.attachErr != nil {
		return domain.WorkPhoto{}, false, f.attachErr
	}
	if f.attachPhoto.Kind != "" {
		return f.attachPhoto, f.attachCreated, nil
	}
	photo := domain.WorkPhoto{
		VisitRequestID: id,
		URL:            url,
		UploadedAt:     time.Now().UTC(),
	}
	if kind == "before" {
		photo.Kind = domain.WorkPhotoBefore
	} else {
		photo.Kind = domain.WorkPhotoAfter
	}
	return photo, !f.attachReplace, nil
}

func (f *fakeVisitService) UpdateVisitorContact(_ context.Context, _ visit.Actor, visitID, visitorID domain.UUID, phone, idNumber *string) (domain.Visitor, error) {
	f.lastMemberVisit = visitID
	f.lastMemberID = visitorID
	f.lastMemberPhone = phone
	f.lastMemberIDNo = idNumber
	if f.memberErr != nil {
		return domain.Visitor{}, f.memberErr
	}
	if f.updatedMember != nil {
		return *f.updatedMember, nil
	}
	return cannedVisit().Visitors[0], nil
}

// fakeGateService is a hand-written fake for handlers.GateService.
type fakeGateService struct {
	checkInResult domain.CheckIn
	checkInErr    error
	lastKey       string
	lastInput     gate.CheckInInput

	checkOutResult domain.CheckOut
	checkOutErr    error
	lastOutID      domain.UUID

	completeErr    error
	lastCompleteID domain.UUID
}

func (f *fakeGateService) CheckIn(_ context.Context, _ gate.Actor, key string, in gate.CheckInInput) (domain.CheckIn, error) {
	f.lastKey = key
	f.lastInput = in
	if f.checkInErr != nil {
		return domain.CheckIn{}, f.checkInErr
	}
	return f.checkInResult, nil
}

func (f *fakeGateService) CheckOut(_ context.Context, _ gate.Actor, id domain.UUID) (domain.CheckOut, error) {
	f.lastOutID = id
	if f.checkOutErr != nil {
		return domain.CheckOut{}, f.checkOutErr
	}
	return f.checkOutResult, nil
}

func (f *fakeGateService) CompleteVisit(_ context.Context, _ gate.Actor, id domain.UUID) error {
	f.lastCompleteID = id
	return f.completeErr
}

// fakeVisitLogReader is a hand-written fake for handlers.VisitLogReader.
type fakeVisitLogReader struct {
	items []handlers.VisitLogDTO
	err   error
	last  domain.UUID
}

func (f *fakeVisitLogReader) ListVisitLogsByVisit(_ context.Context, id domain.UUID) ([]handlers.VisitLogDTO, error) {
	f.last = id
	if f.err != nil {
		return nil, f.err
	}
	return f.items, nil
}

// fakeStorage is a hand-written fake for domain.IStorageService.
type fakeStorage struct {
	uploadCalls int
	lastReq     domain.UploadRequest
	result      domain.UploadResult
	uploadErr   error

	objectKey    string
	objectKeyErr error
	presignURL   string
	presignErr   error
}

func (f *fakeStorage) EnsureBucket(_ context.Context) error { return nil }

func (f *fakeStorage) Upload(_ context.Context, in domain.UploadRequest) (domain.UploadResult, error) {
	f.uploadCalls++
	f.lastReq = in
	if f.uploadErr != nil {
		return domain.UploadResult{}, f.uploadErr
	}
	return f.result, nil
}

func (f *fakeStorage) PresignedURL(_ context.Context, _ string, _ time.Duration) (string, error) {
	if f.presignErr != nil {
		return "", f.presignErr
	}
	return f.presignURL, nil
}

func (f *fakeStorage) DeleteObject(_ context.Context, _ string) error { return nil }

func (f *fakeStorage) ObjectKeyFromStoredURL(_ string) (string, error) {
	if f.objectKeyErr != nil {
		return "", f.objectKeyErr
	}
	if f.objectKey == "" {
		return "", domain.ErrValidation
	}
	return f.objectKey, nil
}

// strPtr boxes a string for optional DTO/domain members in tests.
func strPtr(s string) *string { return &s }

func mustStatus(t *testing.T, rec *httptest.ResponseRecorder, want int) {
	t.Helper()
	if rec.Code != want {
		t.Fatalf("status = %d, want %d: %q", rec.Code, want, rec.Body.String())
	}
}

func mustSuccess(t *testing.T, rec *httptest.ResponseRecorder) envelope {
	t.Helper()
	env := decodeEnvelope(t, rec)
	if !env.Success {
		t.Fatalf("success = false: %q", rec.Body.String())
	}
	if env.Error != nil {
		t.Fatalf("unexpected error body: %+v", env.Error)
	}
	return env
}
