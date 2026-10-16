package handlers_test

// file_handler_test.go pins the RED contract for the planned
// GET /api/v1/visits/:id/file?kind=assignment_letter|id_card|selfie&visitor_id=<uuid>
// endpoint at the HTTP layer. This file is SPECIFICATION ONLY: it intentionally
// fails to build until the GREEN wave lands the API below.
//
// Planned production API (GREEN wave — NOT implemented by this test file):
//
//	// package handlers
//	func NewFileHandler(svc <FileService>) *FileHandler
//	func (h *FileHandler) File(c *gin.Context)
//
//	// <FileService> is the handler's read-port. It is satisfied structurally by
//	// *visit.Service, whose planned method is:
//	//
//	//	func (s *visit.Service) ResolveFileStream(
//	//	    ctx context.Context,
//	//	    actor visit.Actor,
//	//	    visitID domain.UUID,
//	//	    kind visit.FileKind,
//	//	    visitorID domain.UUID,
//	//	) (visit.ObjectStream, error)
//	//
//	//	// package visit (also planned by the GREEN wave)
//	//	type FileKind string
//	//	const (
//	//	    FileKindAssignmentLetter FileKind = "assignment_letter"
//	//	    FileKindIDCard           FileKind = "id_card"
//	//	    FileKindSelfie           FileKind = "selfie"
//	//	)
//	//	type ObjectStream struct {
//	//	    Content     io.ReadCloser
//	//	    Size        int64
//	//	    ContentType string
//	//	    FileName    string
//	//	    ModTime     time.Time
//	//	}
//
// RED expectation: this file fails to build because handlers.NewFileHandler,
// (*handlers.FileHandler).File, visit.FileKind, visit.FileKindAssignmentLetter/
// IDCard/Selfie and visit.ObjectStream do not exist yet. Every assertion below
// IS the contract GREEN implements.
//
// Handler contract (HTTP frame only — scoping/state stay in the usecase):
//   - identity is read FIRST; a caller with no JWT identity is 401 (envelope,
//     code UNAUTHORIZED, message domain.ErrUnauthorized.Error()) and the
//     usecase is never called.
//   - the {id} path segment must parse as a UUID, else 400 VALIDATION_ERROR.
//   - kind must be one of assignment_letter|id_card|selfie, else 400.
//   - id_card/selfie REQUIRE a visitor_id; visitor_id, when present, must parse
//     as a UUID, else 400. Every 400 leaves the usecase uncalled.
//   - a usecase error is projected by response.Fail: ForbiddenBranch -> 403
//     FORBIDDEN_BRANCH, NotFound -> 404 NOT_FOUND.
//   - success streams the bytes inline with Content-Type, Content-Length,
//     Content-Disposition (inline), Cache-Control: private, no-store and
//     Accept-Ranges: bytes; a Range request yields 206 + Content-Range.

import (
	"bytes"
	"context"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/handlers"
	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/visit"
)

const (
	fileVisitID   = "11111111-1111-1111-1111-111111111111"
	fileVisitorID = "22222222-2222-2222-2222-222222222222"
)

// fileFixture is a deterministic 300-byte payload: long enough that a
// Range: bytes=0-99 request is a genuine partial read, not the whole object.
var fileFixture = []byte(strings.Repeat("ABCDEFGHIJ", 30))

// fakeFileService is the handler's read-port double. It builds a FRESH reader
// per call so a single fake can serve several requests, and it records the
// resolved arguments so the 400 tests can prove a rejected request never
// reaches the usecase.
type fakeFileService struct {
	payload     []byte
	contentType string
	fileName    string
	modTime     time.Time
	err         error

	calls       int
	lastActor   visit.Actor
	lastVisit   domain.UUID
	lastKind    visit.FileKind
	lastVisitor domain.UUID
}

func (f *fakeFileService) ResolveFileStream(_ context.Context, actor visit.Actor, visitID domain.UUID, kind visit.FileKind, visitorID domain.UUID) (visit.ObjectStream, error) {
	f.calls++
	f.lastActor = actor
	f.lastVisit = visitID
	f.lastKind = kind
	f.lastVisitor = visitorID
	if f.err != nil {
		return visit.ObjectStream{}, f.err
	}
	return visit.ObjectStream{
		Content:     io.NopCloser(bytes.NewReader(f.payload)),
		Size:        int64(len(f.payload)),
		ContentType: f.contentType,
		FileName:    f.fileName,
		ModTime:     f.modTime,
	}, nil
}

// newFileEngine mounts the route WITHOUT identity middleware, so the missing-
// identity 401 path is reachable.
func newFileEngine(svc *fakeFileService) *gin.Engine {
	engine := gin.New()
	h := handlers.NewFileHandler(svc)
	engine.GET("/visits/:id/file", h.File)
	return engine
}

// newAuthedFileEngine mounts the route behind the documented gin-context
// identity, mirroring newVisitEngine.
func newAuthedFileEngine(svc *fakeFileService, role domain.RoleName, loc string) *gin.Engine {
	engine := gin.New()
	engine.Use(withActor(role, loc))
	h := handlers.NewFileHandler(svc)
	engine.GET("/visits/:id/file", h.File)
	return engine
}

// serveFile issues a GET with extra request headers (the Range path).
func serveFile(engine *gin.Engine, path string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("GET", path, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, req)
	return rec
}

// Given a caller with no JWT identity, when the file endpoint is hit, then it
// is 401 UNAUTHORIZED with the fixed message and the usecase is never called.
func TestFile_NoIdentityIsUnauthorizedWithoutServiceCall(t *testing.T) {
	svc := &fakeFileService{payload: fileFixture, contentType: "application/pdf", fileName: "spk.pdf", modTime: time.Now()}
	engine := newFileEngine(svc)

	rec := serve(engine, "GET", "/visits/"+fileVisitID+"/file?kind=assignment_letter", nil, "")
	mustStatus(t, rec, 401)
	env := decodeEnvelope(t, rec)
	if env.Success {
		t.Fatalf("success = true on 401: %q", rec.Body.String())
	}
	if env.Error == nil || env.Error.Code != "UNAUTHORIZED" {
		t.Fatalf("error = %+v, want UNAUTHORIZED", env.Error)
	}
	if env.Error.Message != domain.ErrUnauthorized.Error() {
		t.Fatalf("message = %q, want %q", env.Error.Message, domain.ErrUnauthorized.Error())
	}
	if svc.calls != 0 {
		t.Fatalf("usecase calls = %d, want 0: an unauthenticated caller must never reach the usecase", svc.calls)
	}
}

// Given an admin outside the visit's branch, when the file is requested, then
// the usecase's branch refusal projects to 403 FORBIDDEN_BRANCH with the fixed
// message and no body bytes leak.
func TestFile_CrossBranchAdminForbidden(t *testing.T) {
	svc := &fakeFileService{err: domain.ForbiddenBranch()}
	engine := newAuthedFileEngine(svc, domain.RoleAdmin, "loc-B")

	rec := serve(engine, "GET", "/visits/"+fileVisitID+"/file?kind=assignment_letter", nil, "")
	mustStatus(t, rec, 403)
	env := decodeEnvelope(t, rec)
	if env.Error == nil || env.Error.Code != "FORBIDDEN_BRANCH" {
		t.Fatalf("error = %+v, want FORBIDDEN_BRANCH", env.Error)
	}
	if env.Error.Message != domain.ErrForbiddenBranch.Error() {
		t.Fatalf("message = %q, want %q", env.Error.Message, domain.ErrForbiddenBranch.Error())
	}
}

// Given a slot with no stored object, when it is requested, then the usecase's
// not-found projects to 404 NOT_FOUND.
func TestFile_EmptySlotIsNotFound(t *testing.T) {
	svc := &fakeFileService{err: domain.NotFoundEntity("Berkas")}
	engine := newAuthedFileEngine(svc, domain.RoleAdmin, "loc-A")

	rec := serve(engine, "GET", "/visits/"+fileVisitID+"/file?kind=assignment_letter", nil, "")
	mustStatus(t, rec, 404)
	env := decodeEnvelope(t, rec)
	if env.Error == nil || env.Error.Code != "NOT_FOUND" {
		t.Fatalf("error = %+v, want NOT_FOUND", env.Error)
	}
}

// Given malformed query parameters, when the endpoint is hit, then each is a
// 400 VALIDATION_ERROR and the usecase is never called (fail before the read).
func TestFile_BadKindOrVisitorIDRejectedWithoutServiceCall(t *testing.T) {
	cases := []struct {
		name string
		url  string
	}{
		{"missing kind", "/visits/" + fileVisitID + "/file"},
		{"unknown kind", "/visits/" + fileVisitID + "/file?kind=bogus"},
		{"id_card without visitor_id", "/visits/" + fileVisitID + "/file?kind=id_card"},
		{"selfie without visitor_id", "/visits/" + fileVisitID + "/file?kind=selfie"},
		{"malformed visitor_id", "/visits/" + fileVisitID + "/file?kind=id_card&visitor_id=not-a-uuid"},
		{"malformed visit id", "/visits/not-a-uuid/file?kind=assignment_letter"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc := &fakeFileService{payload: fileFixture, contentType: "application/pdf", fileName: "spk.pdf", modTime: time.Now()}
			engine := newAuthedFileEngine(svc, domain.RoleAdmin, "loc-A")

			rec := serve(engine, "GET", tc.url, nil, "")
			mustStatus(t, rec, 400)
			env := decodeEnvelope(t, rec)
			if env.Error == nil || env.Error.Code != "VALIDATION_ERROR" {
				t.Fatalf("error = %+v, want VALIDATION_ERROR", env.Error)
			}
			if svc.calls != 0 {
				t.Fatalf("usecase calls = %d, want 0: a malformed request must be refused before the read", svc.calls)
			}
		})
	}
}

// Given an authorized read of the SPK slot, when it resolves, then the bytes
// stream inline with the caching/range headers and the parsed kind/visit reach
// the usecase exactly once.
func TestFile_SuccessStreamsInlineWithHeaders(t *testing.T) {
	svc := &fakeFileService{
		payload:     fileFixture,
		contentType: "application/pdf",
		fileName:    "spk.pdf",
		modTime:     time.Date(2026, time.October, 1, 9, 0, 0, 0, time.UTC),
	}
	engine := newAuthedFileEngine(svc, domain.RoleAdmin, "loc-A")

	rec := serve(engine, "GET", "/visits/"+fileVisitID+"/file?kind=assignment_letter", nil, "")
	mustStatus(t, rec, 200)

	if got := rec.Header().Get("Content-Type"); got != "application/pdf" {
		t.Fatalf("Content-Type = %q, want application/pdf", got)
	}
	if got := rec.Header().Get("Content-Length"); got != "300" {
		t.Fatalf("Content-Length = %q, want 300", got)
	}
	if got := rec.Header().Get("Content-Disposition"); !strings.HasPrefix(got, "inline") {
		t.Fatalf("Content-Disposition = %q, want an inline disposition", got)
	}
	if got := rec.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("Cache-Control = %q, want private, no-store", got)
	}
	if got := rec.Header().Get("Accept-Ranges"); got != "bytes" {
		t.Fatalf("Accept-Ranges = %q, want bytes", got)
	}

	if !bytes.Equal(rec.Body.Bytes(), fileFixture) {
		t.Fatalf("body = %q, want %q", rec.Body.String(), string(fileFixture))
	}
	if svc.calls != 1 {
		t.Fatalf("usecase calls = %d, want 1", svc.calls)
	}
	if svc.lastKind != visit.FileKindAssignmentLetter {
		t.Fatalf("kind = %q, want assignment_letter", svc.lastKind)
	}
	if svc.lastVisit != domain.UUID(fileVisitID) {
		t.Fatalf("visitID = %q, want %q", svc.lastVisit, fileVisitID)
	}
}

// Given an authorized read with a byte range, when it is requested, then the
// handler answers 206 with the partial body and the correct Content-Range.
func TestFile_RangeRequestReturns206WithContentRange(t *testing.T) {
	svc := &fakeFileService{
		payload:     fileFixture,
		contentType: "application/pdf",
		fileName:    "spk.pdf",
		modTime:     time.Date(2026, time.October, 1, 9, 0, 0, 0, time.UTC),
	}
	engine := newAuthedFileEngine(svc, domain.RoleAdmin, "loc-A")

	rec := serveFile(engine, "/visits/"+fileVisitID+"/file?kind=assignment_letter",
		map[string]string{"Range": "bytes=0-99"})
	mustStatus(t, rec, 206)

	if got := rec.Header().Get("Content-Range"); got != "bytes 0-99/300" {
		t.Fatalf("Content-Range = %q, want bytes 0-99/300", got)
	}
	if !bytes.Equal(rec.Body.Bytes(), fileFixture[:100]) {
		t.Fatalf("body = %q, want the first 100 bytes", rec.Body.String())
	}
}
