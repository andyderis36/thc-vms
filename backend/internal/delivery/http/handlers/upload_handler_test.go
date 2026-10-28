package handlers_test

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/handlers"
	"thc-vms/backend/internal/domain"
)

// countingReadCloser records how many bytes were consumed and reports EOF on
// every read after the source is exhausted.
type countingReadCloser struct {
	src  io.Reader
	read int
	eof  bool
}

func (r *countingReadCloser) Read(p []byte) (int, error) {
	if r.eof {
		return 0, io.EOF
	}
	n, err := r.src.Read(p)
	r.read += n
	if err != nil {
		r.eof = true
	}
	return n, err
}

func (r *countingReadCloser) Close() error { return nil }

func newUploadEngine(storage *fakeStorage, maxBytes int64) *gin.Engine {
	engine := gin.New()
	engine.Use(withActor(domain.RoleVendor, ""))
	h := handlers.NewUploadHandler(storage, maxBytes)
	engine.POST("/uploads", h.Upload)
	return engine
}

// multipartUpload builds a multipart body with one file part plus form fields.
func multipartUpload(t *testing.T, fileName, mime string, content []byte, fields map[string]string) (body []byte, contentType string) {
	t.Helper()
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", `form-data; name="file"; filename="`+fileName+`"`)
	header.Set("Content-Type", mime)
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatalf("create part: %v", err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatalf("write part: %v", err)
	}
	for k, v := range fields {
		if err := writer.WriteField(k, v); err != nil {
			t.Fatalf("write field %s: %v", k, err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close writer: %v", err)
	}
	return buf.Bytes(), writer.FormDataContentType()
}

func TestUpload_RejectsOversizeBodyWith413(t *testing.T) {
	storage := &fakeStorage{result: domain.UploadResult{FileURL: "http://x/f", FileName: "f.pdf", FileSize: 1, MimeType: "application/pdf"}}
	engine := newUploadEngine(storage, 1024)

	big := bytes.Repeat([]byte("A"), 2048)
	body, ctype := multipartUpload(t, "spk.pdf", "application/pdf", big,
		map[string]string{"category": "assignment_letter", "owner_id": "visit-1"})

	rec := serve(engine, "POST", "/uploads", body, ctype)
	mustStatus(t, rec, 413)
	if storage.uploadCalls != 0 {
		t.Fatalf("oversized body reached storage (%d calls): it must be refused before buffering", storage.uploadCalls)
	}
}

// TestUpload_OversizeBodyOfCapPlusOneIsDrained pins the boundary case: a body
// exactly one byte past the ingest ceiling is a 413 and the reader ends
// exhausted.
func TestUpload_OversizeBodyOfCapPlusOneIsDrained(t *testing.T) {
	const maxIngest = 1024
	storage := &fakeStorage{}
	engine := newUploadEngine(storage, maxIngest)

	body, contentType := multipartUploadOfSize(t, maxIngest+1)
	rec, counting := serveCountingUpload(engine, body, contentType)

	mustStatus(t, rec, http.StatusRequestEntityTooLarge)
	env := decodeEnvelope(t, rec)
	if env.Error == nil || env.Error.Code != "FILE_TOO_LARGE" {
		t.Fatalf("error = %+v, want code FILE_TOO_LARGE", env.Error)
	}
	if counting.read != len(body) {
		t.Fatalf("drained %d of %d bytes: the 413 must consume the whole body", counting.read, len(body))
	}
	if storage.uploadCalls != 0 {
		t.Fatalf("oversized body reached storage (%d calls)", storage.uploadCalls)
	}
}

// TestUpload_DrainsRemainderBeyondMaxBytesReaderBefore413 is the I-05
// regression guard. MaxBytesReader stops after cap+1 bytes, so only the
// handler's bounded drain can consume the rest; without it this reader stays
// partially unread and net/http would reset the connection.
func TestUpload_DrainsRemainderBeyondMaxBytesReaderBefore413(t *testing.T) {
	const maxIngest = 1024
	storage := &fakeStorage{}
	engine := newUploadEngine(storage, maxIngest)

	// Total ≤ 2*cap+1 so one bounded drain of cap bytes is enough to exhaust it.
	body, contentType := multipartUploadOfSize(t, 1600)
	rec, counting := serveCountingUpload(engine, body, contentType)

	mustStatus(t, rec, http.StatusRequestEntityTooLarge)
	env := decodeEnvelope(t, rec)
	if env.Error == nil || env.Error.Code != "FILE_TOO_LARGE" {
		t.Fatalf("error = %+v, want code FILE_TOO_LARGE", env.Error)
	}
	if counting.read != len(body) {
		t.Fatalf("drained %d of %d bytes: the 413 must consume the whole body", counting.read, len(body))
	}
	if storage.uploadCalls != 0 {
		t.Fatalf("oversized body reached storage (%d calls)", storage.uploadCalls)
	}
}

func serveCountingUpload(engine *gin.Engine, body []byte, contentType string) (*httptest.ResponseRecorder, *countingReadCloser) {
	counting := &countingReadCloser{src: bytes.NewReader(body)}
	req := httptest.NewRequest(http.MethodPost, "/uploads", http.NoBody)
	req.Body = counting
	req.ContentLength = int64(len(body))
	req.Header.Set("Content-Type", contentType)
	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, req)
	return rec, counting
}

// multipartUploadOfSize builds a one-file multipart body that is exactly size
// bytes long, so the oversize test can pin body length to the cap+1 boundary.
func multipartUploadOfSize(t *testing.T, size int) ([]byte, string) {
	t.Helper()
	fields := map[string]string{"category": "assignment_letter"}
	framing, _ := multipartUpload(t, "spk.pdf", "application/pdf", nil, fields)
	contentLen := size - len(framing)
	if contentLen < 1 {
		t.Fatalf("target size %d is below the multipart framing of %d bytes", size, len(framing))
	}
	body, contentType := multipartUpload(t, "spk.pdf", "application/pdf",
		bytes.Repeat([]byte("A"), contentLen), fields)
	if len(body) != size {
		t.Fatalf("multipart body = %d bytes, want exactly %d", len(body), size)
	}
	return body, contentType
}

func TestUpload_RejectsUnknownCategory(t *testing.T) {
	storage := &fakeStorage{}
	engine := newUploadEngine(storage, 5*1024*1024)

	body, ctype := multipartUpload(t, "x.jpg", "image/jpeg", []byte("hello"),
		map[string]string{"category": "selfie", "owner_id": "visit-1"})
	rec := serve(engine, "POST", "/uploads", body, ctype)
	mustStatus(t, rec, 400)
	if storage.uploadCalls != 0 {
		t.Fatalf("unknown category reached storage")
	}
}

// TestUpload_ProfilePhotoPassesImageHint pins the avatar upload path: the
// profile_photo category reaches storage under the actor's own namespace, which
// is the same prefix the auth profile write gate demands of avatar_url.
func TestUpload_ProfilePhotoPassesImageHint(t *testing.T) {
	storage := &fakeStorage{result: domain.UploadResult{
		FileURL:  "http://localhost:9000/thc-vms-bucket/profile_photos/pending-actor-1/avatar.jpg",
		FileName: "avatar.jpg",
		FileSize: 5,
		MimeType: "image/jpeg",
	}}
	engine := newUploadEngine(storage, 5*1024*1024)

	body, ctype := multipartUpload(t, "avatar.jpg", "image/jpeg", []byte("hello"),
		map[string]string{"category": "profile_photo", "owner_id": "someone-else"})
	rec := serve(engine, "POST", "/uploads", body, ctype)
	mustStatus(t, rec, 201)

	if storage.uploadCalls != 1 {
		t.Fatalf("upload calls = %d, want 1", storage.uploadCalls)
	}
	if storage.lastReq.ObjectKey != "profile_photo/pending-actor-1" {
		t.Fatalf("ObjectKey = %q, want the actor namespace", storage.lastReq.ObjectKey)
	}
}

// TestUpload_ProfilePhotoRejectsPDF keeps the avatar an image-only upload: PDF
// is allowed for visit documents but is never a valid profile photo.
func TestUpload_ProfilePhotoRejectsPDF(t *testing.T) {
	storage := &fakeStorage{}
	engine := newUploadEngine(storage, 5*1024*1024)

	body, ctype := multipartUpload(t, "spk.pdf", "application/pdf", []byte("hello"),
		map[string]string{"category": "profile_photo"})
	rec := serve(engine, "POST", "/uploads", body, ctype)
	mustStatus(t, rec, 400)
	if storage.uploadCalls != 0 {
		t.Fatalf("a PDF avatar reached storage")
	}
}

func TestUpload_RejectsDisallowedMIME(t *testing.T) {
	storage := &fakeStorage{}
	engine := newUploadEngine(storage, 5*1024*1024)

	body, ctype := multipartUpload(t, "note.txt", "text/plain", []byte("hello"),
		map[string]string{"category": "id_card", "owner_id": "visitor-1"})
	rec := serve(engine, "POST", "/uploads", body, ctype)
	mustStatus(t, rec, 400)
	if storage.uploadCalls != 0 {
		t.Fatalf("disallowed MIME reached storage")
	}
}

// TestUpload_PassesCategoryHintAndServerDerivedOwnerToStorage pins the storage
// hint contract: the category passes through verbatim and the owner segment is
// derived from the authenticated actor (withActor sets user id "actor-1"), NOT
// from the client-supplied owner_id.
func TestUpload_PassesCategoryHintAndServerDerivedOwnerToStorage(t *testing.T) {
	storage := &fakeStorage{result: domain.UploadResult{
		FileURL:  "http://localhost:9000/thc-vms-bucket/assignment_letters/pending-actor-1/spk.pdf",
		FileName: "spk.pdf",
		FileSize: 5,
		MimeType: "application/pdf",
	}}
	engine := newUploadEngine(storage, 5*1024*1024)

	body, ctype := multipartUpload(t, "spk.pdf", "application/pdf", []byte("hello"),
		map[string]string{"category": "assignment_letter", "owner_id": "visit-1"})
	rec := serve(engine, "POST", "/uploads", body, ctype)
	mustStatus(t, rec, 201)
	env := mustSuccess(t, rec)

	var data map[string]json.RawMessage
	if err := json.Unmarshal(env.Data, &data); err != nil {
		t.Fatalf("upload data is not an object: %v", err)
	}
	for _, key := range []string{"file_url", "file_name", "file_size", "mime_type"} {
		if _, ok := data[key]; !ok {
			t.Fatalf("upload data missing key %q: %q", key, string(env.Data))
		}
	}

	// The adapter must receive a "category/ownerSegment" HINT, never a full
	// path. The category passes through; the owner segment is server-derived
	// (withActor sets user id "actor-1"), not taken from the client owner_id.
	if storage.uploadCalls != 1 {
		t.Fatalf("upload calls = %d, want 1", storage.uploadCalls)
	}
	if storage.lastReq.ObjectKey != "assignment_letter/pending-actor-1" {
		t.Fatalf("ObjectKey = %q, want hint %q", storage.lastReq.ObjectKey, "assignment_letter/pending-actor-1")
	}
	if strings.Count(storage.lastReq.ObjectKey, "/") != 1 {
		t.Fatalf("ObjectKey must be exactly category/ownerSegment: %q", storage.lastReq.ObjectKey)
	}
}

func TestUpload_MissingOwnerIDUsesServerDerivedOwner(t *testing.T) {
	storage := &fakeStorage{result: domain.UploadResult{
		FileURL:  "http://localhost:9000/thc-vms-bucket/assignment_letters/pending-actor-1/spk.pdf",
		FileName: "spk.pdf",
		FileSize: 5,
		MimeType: "application/pdf",
	}}
	engine := newUploadEngine(storage, 5*1024*1024)

	// Pre-create flow (/visits/new): no visit id yet, only file + category. The
	// owner segment still comes from the actor, never from a missing field.
	body, ctype := multipartUpload(t, "spk.pdf", "application/pdf", []byte("hello"),
		map[string]string{"category": "assignment_letter"})
	rec := serve(engine, "POST", "/uploads", body, ctype)
	mustStatus(t, rec, 201)
	if storage.uploadCalls != 1 {
		t.Fatalf("upload calls = %d, want 1", storage.uploadCalls)
	}
	if storage.lastReq.ObjectKey != "assignment_letter/pending-actor-1" {
		t.Fatalf("ObjectKey = %q, want hint %q", storage.lastReq.ObjectKey, "assignment_letter/pending-actor-1")
	}
}

// TestUpload_IgnoresClientOwnerID is the regression guard for the storage
// namespace vulnerability: a client-supplied owner_id must never reach the
// object key, so an authenticated caller cannot write into another branch's
// visit namespace. The owner segment is always server-derived from the actor.
func TestUpload_IgnoresClientOwnerID(t *testing.T) {
	storage := &fakeStorage{result: domain.UploadResult{
		FileURL:  "http://localhost:9000/thc-vms-bucket/assignment_letters/pending-actor-1/spk.pdf",
		FileName: "spk.pdf",
		FileSize: 5,
		MimeType: "application/pdf",
	}}
	engine := newUploadEngine(storage, 5*1024*1024)

	const foreignOwnerID = "VST-8837710235"
	body, ctype := multipartUpload(t, "spk.pdf", "application/pdf", []byte("hello"),
		map[string]string{"category": "assignment_letter", "owner_id": foreignOwnerID})
	rec := serve(engine, "POST", "/uploads", body, ctype)
	mustStatus(t, rec, 201)
	if storage.uploadCalls != 1 {
		t.Fatalf("upload calls = %d, want 1", storage.uploadCalls)
	}
	if strings.Contains(storage.lastReq.ObjectKey, foreignOwnerID) {
		t.Fatalf("client owner_id %q leaked into ObjectKey %q", foreignOwnerID, storage.lastReq.ObjectKey)
	}
	if storage.lastReq.ObjectKey != "assignment_letter/pending-actor-1" {
		t.Fatalf("ObjectKey = %q, want server-derived hint %q", storage.lastReq.ObjectKey, "assignment_letter/pending-actor-1")
	}
}

// TestUpload_UnresolvedActorFallsBackToBarePending locks the defensive branch:
// when no actor is in the context the owner segment is the bare "pending"
// literal, never a client-supplied value.
func TestUpload_UnresolvedActorFallsBackToBarePending(t *testing.T) {
	storage := &fakeStorage{result: domain.UploadResult{
		FileURL:  "http://localhost:9000/thc-vms-bucket/assignment_letters/pending/spk.pdf",
		FileName: "spk.pdf",
		FileSize: 5,
		MimeType: "application/pdf",
	}}
	engine := gin.New() // no auth middleware: identity resolution fails closed
	h := handlers.NewUploadHandler(storage, 5*1024*1024)
	engine.POST("/uploads", h.Upload)

	body, ctype := multipartUpload(t, "spk.pdf", "application/pdf", []byte("hello"),
		map[string]string{"category": "assignment_letter", "owner_id": "VST-0000000009"})
	rec := serve(engine, "POST", "/uploads", body, ctype)
	mustStatus(t, rec, 201)
	if storage.lastReq.ObjectKey != "assignment_letter/pending" {
		t.Fatalf("ObjectKey = %q, want bare pending hint %q", storage.lastReq.ObjectKey, "assignment_letter/pending")
	}
}
