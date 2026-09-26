package http_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	deliveryhttp "thc-vms/backend/internal/delivery/http"
)

// errDBDown simulates an unreachable pool.
var errDBDown = errors.New("connection refused")

// fakePinger answers Ping with a canned error.
type fakePinger struct{ err error }

func (f fakePinger) Ping(_ context.Context) error { return f.err }

func serveHealth(handler *deliveryhttp.HealthHandler, path string) *httptest.ResponseRecorder {
	engine := gin.New()
	engine.GET("/health", handler.Health)
	engine.GET("/ready", handler.Ready)
	req := httptest.NewRequest(http.MethodGet, path, nil)
	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, req)
	return rec
}

// TestHealth_ReturnsHealthyPayload asserts GET /health answers 200 with the
// openapi HealthResponse shape and needs no database.
func TestHealth_ReturnsHealthyPayload(t *testing.T) {
	handler := deliveryhttp.NewHealthHandler(nil)
	rec := serveHealth(handler, "/health")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %q", rec.Code, rec.Body.String())
	}
	var env struct {
		Success bool `json:"success"`
		Data    struct {
			Status    string `json:"status"`
			Uptime    string `json:"uptime"`
			Timestamp string `json:"timestamp"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("response is not JSON: %v: %q", err, rec.Body.String())
	}
	if !env.Success || env.Data.Status == "" || env.Data.Uptime == "" || env.Data.Timestamp == "" {
		t.Fatalf("response is not the HealthResponse shape: %q", rec.Body.String())
	}
}

// TestReady_Returns503WhenTheDatabaseIsDown asserts GET /ready answers 503
// through the failure envelope when the pool does not answer.
func TestReady_Returns503WhenTheDatabaseIsDown(t *testing.T) {
	handler := deliveryhttp.NewHealthHandler(fakePinger{err: errDBDown})
	rec := serveHealth(handler, "/ready")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503: %q", rec.Code, rec.Body.String())
	}
	var env struct {
		Success bool `json:"success"`
		Error   *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("response is not JSON: %v: %q", err, rec.Body.String())
	}
	if env.Success || env.Error == nil {
		t.Fatalf("response is not the failure envelope: %q", rec.Body.String())
	}
}

// TestReady_Returns200WhenTheDatabaseAnswers asserts GET /ready answers 200
// when the pool pings cleanly.
func TestReady_Returns200WhenTheDatabaseAnswers(t *testing.T) {
	handler := deliveryhttp.NewHealthHandler(fakePinger{})
	rec := serveHealth(handler, "/ready")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %q", rec.Code, rec.Body.String())
	}
}
