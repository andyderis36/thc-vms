package middleware_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/middleware"
)

func TestRateLimiter_RecoversAfterWindow(t *testing.T) {
	gin.SetMode(gin.TestMode)
	limiter := middleware.NewRateLimiter(1, 40*time.Millisecond)
	r := gin.New()
	r.POST("/auth/login", limiter.Middleware(), okHandler)

	serve := func() int {
		req := httptest.NewRequest(http.MethodPost, "/auth/login", nil)
		req.RemoteAddr = "10.0.0.10:1234"
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec.Code
	}
	if code := serve(); code != http.StatusOK {
		t.Fatalf("attempt 1 = %d, want 200", code)
	}
	if code := serve(); code != http.StatusTooManyRequests {
		t.Fatalf("attempt 2 = %d, want 429", code)
	}
	time.Sleep(60 * time.Millisecond)
	if code := serve(); code != http.StatusOK {
		t.Fatalf("after window = %d, want 200", code)
	}
}

func TestRecovery_PanicBecomes500Envelope(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(middleware.Recovery())
	r.GET("/boom", func(_ *gin.Context) { panic("kaboom") })

	req := httptest.NewRequest(http.MethodGet, "/boom", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("panic status = %d, want 500", rec.Code)
	}
	assertFailureEnvelope(t, rec.Body.String())
}

func TestCORS_PreflightAnswers204(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(middleware.CORS())
	r.GET("/auth/me", okHandler)

	req := httptest.NewRequest(http.MethodOptions, "/auth/me", nil)
	req.Header.Set("Origin", "http://localhost:3210")
	req.Header.Set("Access-Control-Request-Method", "GET")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d, want 204", rec.Code)
	}
	if rec.Header().Get("Access-Control-Allow-Origin") == "" {
		t.Fatal("preflight must echo an Access-Control-Allow-Origin header")
	}
}
