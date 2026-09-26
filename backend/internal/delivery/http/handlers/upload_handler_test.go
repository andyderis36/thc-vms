package handlers_test

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/textproto"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/handlers"
	"thc-vms/backend/internal/domain"
)

func newUploadEngine(storage *fakeStorage, maxBytes int64) *gin.Engine {
	engine := gin.New()
	engine.Use(withActor(domain.RolePIC, ""))
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

func TestUpload_RejectsUnknownCategory(t *testing.T) {
	storage := &fakeStorage{}
	engine := newUploadEngine(storage, 5*1024*1024)

	body, ctype := multipartUpload(t, "spk.pdf", "application/pdf", []byte("x"),
		map[string]string{"category": "selfie", "owner_id": "visit-1"})
	rec := serve(engine, "POST", "/uploads", body, ctype)
	mustStatus(t, rec, 400)
	if storage.uploadCalls != 0 {
		t.Fatalf("unknown category reached storage")
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

func TestUpload_PassesCategoryOwnerHintToStorage(t *testing.T) {
	storage := &fakeStorage{result: domain.UploadResult{
		FileURL:  "http://localhost:9000/thc-vms-bucket/assignment_letters/visit-1/spk.pdf",
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

	// The adapter must receive a "category/ownerID" HINT, never a full path.
	if storage.uploadCalls != 1 {
		t.Fatalf("upload calls = %d, want 1", storage.uploadCalls)
	}
	if storage.lastReq.ObjectKey != "assignment_letter/visit-1" {
		t.Fatalf("ObjectKey = %q, want hint %q", storage.lastReq.ObjectKey, "assignment_letter/visit-1")
	}
	if strings.Count(storage.lastReq.ObjectKey, "/") != 1 {
		t.Fatalf("ObjectKey must be exactly category/ownerID: %q", storage.lastReq.ObjectKey)
	}
}
