package http_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	deliveryhttp "thc-vms/backend/internal/delivery/http"
	"thc-vms/backend/internal/domain"
)

func TestRequestMetaFromGin_CapturesIPAndUserAgent(t *testing.T) {
	gin.SetMode(gin.TestMode)
	var got domain.RequestMeta
	r := gin.New()
	r.GET("/probe", func(c *gin.Context) {
		got = deliveryhttp.RequestMetaFromGin(c)
		c.Status(http.StatusNoContent)
	})

	req := httptest.NewRequest(http.MethodGet, "/probe", nil)
	req.Header.Set("User-Agent", "AuditProbe/2.0")
	req.RemoteAddr = "203.0.113.9:5555"
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("probe status = %d", rec.Code)
	}
	if got.IP != "203.0.113.9" || got.UserAgent != "AuditProbe/2.0" {
		t.Fatalf("provenance = %+v, want ip+agent", got)
	}
}

func TestRequestMeta_OverlongValuesAreTruncated(t *testing.T) {
	gin.SetMode(gin.TestMode)
	var got domain.RequestMeta
	r := gin.New()
	r.GET("/probe", func(c *gin.Context) {
		got = deliveryhttp.RequestMetaFromGin(c)
		c.Status(http.StatusNoContent)
	})

	req := httptest.NewRequest(http.MethodGet, "/probe", nil)
	req.Header.Set("User-Agent", strings.Repeat("A", 900))
	req.RemoteAddr = "203.0.113.9:5555"
	r.ServeHTTP(httptest.NewRecorder(), req)
	if len(got.UserAgent) != 512 {
		t.Fatalf("user agent length = %d, want 512", len(got.UserAgent))
	}
}

func TestContextWithRequestMeta_TravelsOnContext(t *testing.T) {
	gin.SetMode(gin.TestMode)
	var ok bool
	var meta domain.RequestMeta
	r := gin.New()
	r.GET("/probe", func(c *gin.Context) {
		ctx := deliveryhttp.ContextWithRequestMeta(c.Request.Context(), c)
		meta, ok = domain.RequestMetaFromContext(ctx)
		c.Status(http.StatusNoContent)
	})

	req := httptest.NewRequest(http.MethodGet, "/probe", nil)
	req.Header.Set("User-Agent", "CtxTravel/1.0")
	req.RemoteAddr = "198.51.100.4:1234"
	r.ServeHTTP(httptest.NewRecorder(), req)
	if !ok || meta.IP != "198.51.100.4" || meta.UserAgent != "CtxTravel/1.0" {
		t.Fatalf("context provenance = %+v,%v", meta, ok)
	}
}
