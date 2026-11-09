package http_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	deliveryhttp "thc-vms/backend/internal/delivery/http"
	"thc-vms/backend/internal/domain"
)

func TestIdentity_RoundTripThroughContext(t *testing.T) {
	gin.SetMode(gin.TestMode)
	loc := domain.UUID("loc-1")
	want := deliveryhttp.Identity{
		UserID:     domain.UUID("user-1"),
		Role:       domain.RoleAdmin,
		LocationID: &loc,
	}

	r := gin.New()
	r.GET("/whoami",
		func(c *gin.Context) {
			deliveryhttp.WithIdentity(c, want)
			c.Next()
		},
		func(c *gin.Context) {
			got, ok := deliveryhttp.IdentityFrom(c)
			if !ok {
				c.Status(http.StatusUnauthorized)
				return
			}
			if got.UserID != want.UserID || got.Role != want.Role ||
				got.LocationID == nil || *got.LocationID != *want.LocationID {
				c.Status(http.StatusTeapot)
				return
			}
			c.Status(http.StatusOK)
		},
	)

	req := httptest.NewRequest(http.MethodGet, "/whoami", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("round trip status = %d, want %d", rec.Code, http.StatusOK)
	}
}

func TestIdentity_MissingReturnsFalse(t *testing.T) {
	gin.SetMode(gin.TestMode)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	if _, ok := deliveryhttp.IdentityFrom(c); ok {
		t.Fatal("IdentityFrom must report false when no identity was stored")
	}
}

func TestScope_RoundTripThroughContext(t *testing.T) {
	gin.SetMode(gin.TestMode)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	want := deliveryhttp.Scope{
		LocationIDs: []domain.UUID{"loc-a", "loc-b"},
		IsGlobal:    false,
	}
	deliveryhttp.WithScope(c, want)
	got, ok := deliveryhttp.ScopeFrom(c)
	if !ok {
		t.Fatal("ScopeFrom must report true when a scope was stashed")
	}
	if got.IsGlobal != want.IsGlobal || len(got.LocationIDs) != 2 ||
		got.LocationIDs[0] != "loc-a" || got.LocationIDs[1] != "loc-b" {
		t.Fatalf("ScopeFrom = %+v, want %+v", got, want)
	}
}

func TestScope_MissingReturnsFalse(t *testing.T) {
	gin.SetMode(gin.TestMode)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	if _, ok := deliveryhttp.ScopeFrom(c); ok {
		t.Fatal("ScopeFrom must report false when no scope was stashed")
	}
}

func TestRequireIdentity_RejectsAnonymous(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/guarded", deliveryhttp.RequireIdentity(), func(c *gin.Context) {
		c.Status(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/guarded", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}
