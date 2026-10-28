package handlers_test

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
	"thc-vms/backend/internal/usecase/avatar"
)

const avatarTargetID = "22222222-2222-2222-2222-222222222222"

// avatarFixture is a deterministic payload long enough to prove the bytes are
// streamed verbatim.
var avatarFixture = []byte(strings.Repeat("avatarbytes/", 24))

// fakeAvatarService is the handler's read-port double. It records the resolved
// arguments so the 400/401 tests can prove a refused request never reaches the
// usecase.
type fakeAvatarService struct {
	payload     []byte
	contentType string
	modTime     time.Time
	etag        string
	err         error

	calls     int
	lastActor avatar.Actor
	lastID    domain.UUID
	lastBody  *trackingAvatarBody
}

func (f *fakeAvatarService) ResolveAvatarStream(_ context.Context, actor avatar.Actor, targetID domain.UUID) (avatar.Stream, error) {
	f.calls++
	f.lastActor = actor
	f.lastID = targetID
	if f.err != nil {
		return avatar.Stream{}, f.err
	}
	f.lastBody = &trackingAvatarBody{data: f.payload}
	return avatar.Stream{
		Content:     f.lastBody,
		Size:        int64(len(f.payload)),
		ContentType: f.contentType,
		ModTime:     f.modTime,
		ETag:        f.etag,
	}, nil
}

// trackingAvatarBody records whether the handler closed the stream.
type trackingAvatarBody struct {
	data   []byte
	pos    int
	closed bool
}

func (b *trackingAvatarBody) Read(p []byte) (int, error) {
	if b.pos >= len(b.data) {
		return 0, io.EOF
	}
	n := copy(p, b.data[b.pos:])
	b.pos += n
	return n, nil
}

func (b *trackingAvatarBody) Close() error {
	b.closed = true
	return nil
}

// newAvatarEngine mounts the route WITHOUT identity middleware, so the
// missing-identity 401 path is reachable.
func newAvatarEngine(svc *fakeAvatarService) *gin.Engine {
	engine := gin.New()
	engine.GET("/avatars/:id", handlers.NewAvatarHandler(svc).Avatar)
	return engine
}

// newAuthedAvatarEngine mounts the route behind the documented gin-context
// identity, mirroring newAuthedFileEngine.
func newAuthedAvatarEngine(svc *fakeAvatarService, role domain.RoleName, loc string) *gin.Engine {
	engine := gin.New()
	engine.Use(withActor(role, loc))
	engine.GET("/avatars/:id", handlers.NewAvatarHandler(svc).Avatar)
	return engine
}

// serveAvatar issues a GET with extra request headers (the conditional path).
func serveAvatar(engine *gin.Engine, path string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("GET", path, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, req)
	return rec
}

// Given a caller with no JWT identity, when the avatar endpoint is hit, then it
// is 401 UNAUTHORIZED and the usecase is never called.
func TestAvatar_NoIdentityIsUnauthorizedWithoutServiceCall(t *testing.T) {
	svc := &fakeAvatarService{payload: avatarFixture, contentType: "image/jpeg", modTime: time.Now(), etag: `"etag-1"`}
	engine := newAvatarEngine(svc)

	rec := serve(engine, "GET", "/avatars/"+avatarTargetID, nil, "")
	mustStatus(t, rec, 401)
	env := decodeEnvelope(t, rec)
	if env.Success {
		t.Fatalf("success = true on 401: %q", rec.Body.String())
	}
	if env.Error == nil || env.Error.Code != "UNAUTHORIZED" {
		t.Fatalf("error = %+v, want UNAUTHORIZED", env.Error)
	}
	if svc.calls != 0 {
		t.Fatalf("usecase calls = %d, want 0: an unauthenticated caller must never reach the usecase", svc.calls)
	}
}

// Given a malformed path segment, when the endpoint is hit, then it is a 400
// VALIDATION_ERROR and the usecase is never called.
func TestAvatar_BadUUIDRejectedWithoutServiceCall(t *testing.T) {
	svc := &fakeAvatarService{payload: avatarFixture, contentType: "image/jpeg", modTime: time.Now(), etag: `"etag-1"`}
	engine := newAuthedAvatarEngine(svc, domain.RoleAdmin, "loc-A")

	rec := serve(engine, "GET", "/avatars/not-a-uuid", nil, "")
	mustStatus(t, rec, 400)
	env := decodeEnvelope(t, rec)
	if env.Error == nil || env.Error.Code != "VALIDATION_ERROR" {
		t.Fatalf("error = %+v, want VALIDATION_ERROR", env.Error)
	}
	if svc.calls != 0 {
		t.Fatalf("usecase calls = %d, want 0: a malformed request must be refused before the read", svc.calls)
	}
}

// Given a usecase refusal, when it projects through response.Fail, then the
// failure envelope carries the 404.
func TestAvatar_ServiceNotFoundProjectsTo404(t *testing.T) {
	svc := &fakeAvatarService{err: domain.ErrNotFound}
	engine := newAuthedAvatarEngine(svc, domain.RoleAdmin, "loc-A")

	rec := serve(engine, "GET", "/avatars/"+avatarTargetID, nil, "")
	mustStatus(t, rec, 404)
	env := decodeEnvelope(t, rec)
	if env.Error == nil || env.Error.Code != "NOT_FOUND" {
		t.Fatalf("error = %+v, want NOT_FOUND", env.Error)
	}
}

// Given an authorized read, when the avatar resolves, then the bytes stream
// inline with the caching headers and the parsed id reaches the usecase.
func TestAvatar_SuccessStreamsInlineWithHeaders(t *testing.T) {
	svc := &fakeAvatarService{
		payload:     avatarFixture,
		contentType: "image/jpeg",
		modTime:     time.Date(2026, time.October, 1, 9, 0, 0, 0, time.UTC),
		etag:        `"etag-1"`,
	}
	engine := newAuthedAvatarEngine(svc, domain.RoleAdmin, "loc-A")

	rec := serveAvatar(engine, "/avatars/"+avatarTargetID, nil)
	mustStatus(t, rec, 200)

	if got := rec.Header().Get("Content-Type"); got != "image/jpeg" {
		t.Fatalf("Content-Type = %q, want image/jpeg", got)
	}
	if got := rec.Header().Get("Content-Disposition"); got != `inline; filename="avatar"` {
		t.Fatalf("Content-Disposition = %q, want the fixed inline disposition", got)
	}
	if got := rec.Header().Get("Cache-Control"); got != "private, max-age=300" {
		t.Fatalf("Cache-Control = %q, want private, max-age=300", got)
	}
	if got := rec.Header().Get("ETag"); got != `"etag-1"` {
		t.Fatalf("ETag = %q, want the served etag", got)
	}
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q, want nosniff", got)
	}
	if !bytes.Equal(rec.Body.Bytes(), avatarFixture) {
		t.Fatalf("body = %q, want %q", rec.Body.String(), string(avatarFixture))
	}
	if svc.calls != 1 {
		t.Fatalf("usecase calls = %d, want 1", svc.calls)
	}
	if svc.lastID != domain.UUID(avatarTargetID) {
		t.Fatalf("target id = %q, want %q", svc.lastID, avatarTargetID)
	}
	if svc.lastBody == nil || !svc.lastBody.closed {
		t.Fatal("stream body was not closed after serving")
	}
}

// Given a cached client holding the served ETag, when it revalidates with
// If-None-Match, then the handler answers 304 without a body.
func TestAvatar_IfNoneMatchReturns304(t *testing.T) {
	svc := &fakeAvatarService{
		payload:     avatarFixture,
		contentType: "image/jpeg",
		modTime:     time.Date(2026, time.October, 1, 9, 0, 0, 0, time.UTC),
		etag:        `"etag-1"`,
	}
	engine := newAuthedAvatarEngine(svc, domain.RoleAdmin, "loc-A")

	rec := serveAvatar(engine, "/avatars/"+avatarTargetID, map[string]string{"If-None-Match": `"etag-1"`})
	mustStatus(t, rec, 304)
	if rec.Body.Len() != 0 {
		t.Fatalf("304 must not carry a body, got %q", rec.Body.String())
	}
}
