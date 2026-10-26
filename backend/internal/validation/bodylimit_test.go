package validation_test

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/middleware"
	"thc-vms/backend/internal/delivery/http/response"
)

func TestBodyLimit_JSONBody(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(middleware.BodyLimit(32, "/uploads"))
	r.POST("/echo", func(c *gin.Context) {
		body, err := io.ReadAll(c.Request.Body)
		if err != nil {
			c.Status(http.StatusInternalServerError)
			return
		}
		c.String(http.StatusOK, string(body))
	})

	cases := []struct {
		name        string
		body        string
		contentType string
		wantStatus  int
	}{
		{"within limit", `{"a":1}`, "application/json", http.StatusOK},
		{"over limit", strings.Repeat("a", 64), "application/json", http.StatusRequestEntityTooLarge},
		{"multipart on JSON route", strings.Repeat("a", 64), "multipart/form-data; boundary=x", http.StatusRequestEntityTooLarge},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/echo", strings.NewReader(tc.body))
			req.Header.Set("Content-Type", tc.contentType)
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)
			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d", rec.Code, tc.wantStatus)
			}
			if tc.wantStatus == http.StatusRequestEntityTooLarge {
				var envelope response.Envelope
				if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
					t.Fatalf("decode envelope: %v", err)
				}
				if envelope.Error == nil || envelope.Error.Code != "PAYLOAD_TOO_LARGE" {
					t.Fatalf("error envelope = %+v, want code PAYLOAD_TOO_LARGE", envelope.Error)
				}
			}
		})
	}
}

func TestBodyLimit_MultipartOnUploadRouteReachesHandler(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(middleware.BodyLimit(32, "/uploads"))
	r.POST("/uploads", func(c *gin.Context) {
		body, err := io.ReadAll(c.Request.Body)
		if err != nil {
			c.Status(http.StatusInternalServerError)
			return
		}
		c.String(http.StatusOK, string(body))
	})

	payload := strings.Repeat("a", 64)
	req := httptest.NewRequest(http.MethodPost, "/uploads", strings.NewReader(payload))
	req.Header.Set("Content-Type", "multipart/form-data; boundary=x")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: the upload route owns its own ceiling", rec.Code)
	}
	if rec.Body.String() != payload {
		t.Fatalf("handler body = %q, want %d bytes", rec.Body.String(), len(payload))
	}
}
