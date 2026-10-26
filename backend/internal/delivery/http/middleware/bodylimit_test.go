package middleware_test

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/middleware"
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

func TestBodyLimit_OversizeJSONDrainsBodyBefore413(t *testing.T) {
	const limit = 64
	reached := false
	engine := gin.New()
	engine.Use(middleware.BodyLimit(limit, "/uploads"))
	engine.POST("/x", func(c *gin.Context) {
		reached = true
		c.Status(http.StatusOK)
	})

	payload := strings.Repeat("a", limit+16)
	counting := &countingReadCloser{src: strings.NewReader(payload)}
	req := httptest.NewRequest(http.MethodPost, "/x", http.NoBody)
	req.Body = counting
	req.ContentLength = int64(len(payload))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", rec.Code)
	}
	var body failureBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("not a valid envelope: %v: %q", err, rec.Body.String())
	}
	if body.Error == nil || body.Error.Code != "PAYLOAD_TOO_LARGE" {
		t.Fatalf("error = %+v, want code PAYLOAD_TOO_LARGE", body.Error)
	}
	if counting.read != len(payload) {
		t.Fatalf("drained %d of %d bytes: the 413 must consume the whole body", counting.read, len(payload))
	}
	if reached {
		t.Fatal("oversized body reached the handler")
	}
}

func TestBodyLimit_DeclaredOversizeDrainsBefore413(t *testing.T) {
	const limit = 64
	reached := false
	engine := gin.New()
	engine.Use(middleware.BodyLimit(limit, "/uploads"))
	engine.POST("/x", func(c *gin.Context) {
		reached = true
		c.Status(http.StatusOK)
	})

	payload := strings.Repeat("a", 4096)
	counting := &countingReadCloser{src: strings.NewReader(payload)}
	req := httptest.NewRequest(http.MethodPost, "/x", http.NoBody)
	req.Body = counting
	req.ContentLength = int64(len(payload))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", rec.Code)
	}
	if counting.read != len(payload) {
		t.Fatalf("drained %d of %d bytes: the 413 must consume the declared body", counting.read, len(payload))
	}
	if reached {
		t.Fatal("oversized body reached the handler")
	}
}

func TestBodyLimit_ExpectContinueRejectsBeforeReadingBody(t *testing.T) {
	const limit = 64
	engine := gin.New()
	engine.Use(middleware.BodyLimit(limit, "/uploads"))
	engine.POST("/x", func(c *gin.Context) { c.Status(http.StatusOK) })

	payload := strings.Repeat("a", 4096)
	counting := &countingReadCloser{src: strings.NewReader(payload)}
	req := httptest.NewRequest(http.MethodPost, "/x", http.NoBody)
	req.Body = counting
	req.ContentLength = int64(len(payload))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Expect", "100-continue")
	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", rec.Code)
	}
	if counting.read != 0 {
		t.Fatalf("read %d bytes: a declared oversize must be rejected without reading", counting.read)
	}
}

func TestBodyLimit_ChunkedOversizeDrainsWholeBody(t *testing.T) {
	const limit = 64
	engine := gin.New()
	engine.Use(middleware.BodyLimit(limit, "/uploads"))
	engine.POST("/x", func(c *gin.Context) { c.Status(http.StatusOK) })

	payload := strings.Repeat("a", 4096)
	counting := &countingReadCloser{src: strings.NewReader(payload)}
	req := httptest.NewRequest(http.MethodPost, "/x", http.NoBody)
	req.Body = counting
	req.ContentLength = -1
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", rec.Code)
	}
	if counting.read != len(payload) {
		t.Fatalf("drained %d of %d bytes: the 413 must consume the whole chunked body", counting.read, len(payload))
	}
}

func TestBodyLimit_UnderLimitBodyReachesHandler(t *testing.T) {
	const limit = 64
	var got string
	engine := gin.New()
	engine.Use(middleware.BodyLimit(limit, "/uploads"))
	engine.POST("/x", func(c *gin.Context) {
		raw, _ := io.ReadAll(c.Request.Body)
		got = string(raw)
		c.Status(http.StatusOK)
	})

	payload := `{"ok":true}`
	counting := &countingReadCloser{src: strings.NewReader(payload)}
	req := httptest.NewRequest(http.MethodPost, "/x", http.NoBody)
	req.Body = counting
	req.ContentLength = int64(len(payload))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got != payload {
		t.Fatalf("handler body = %q, want %q", got, payload)
	}
	if counting.read != len(payload) {
		t.Fatalf("read %d of %d bytes", counting.read, len(payload))
	}
}
