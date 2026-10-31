package middleware_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	deliveryhttp "thc-vms/backend/internal/delivery/http"
	"thc-vms/backend/internal/delivery/http/middleware"
	"thc-vms/backend/internal/domain"
	infraJWT "thc-vms/backend/internal/infrastructure/jwt"
	"thc-vms/backend/internal/usecase/auth"
)

// fakeParser is a hand-written TokenParser double: no mocking library. Its
// Parse returns real infraJWT.Claims so the middleware exercises the exact
// type production parses into.
type fakeParser struct {
	claims infraJWT.Claims
	err    error
}

func (f *fakeParser) Parse(_ string) (infraJWT.Claims, error) {
	if f.err != nil {
		return infraJWT.Claims{}, f.err
	}
	return f.claims, nil
}

// fakeLoader is a hand-written ProfileLoader double.
type fakeLoader struct {
	profile auth.Profile
	err     error
}

func (f *fakeLoader) Me(_ context.Context, _ domain.UUID) (auth.Profile, error) {
	if f.err != nil {
		return auth.Profile{}, f.err
	}
	return f.profile, nil
}

func activeProfile() auth.Profile {
	loc := domain.UUID("loc-1")
	return auth.Profile{
		ID:         "user-1",
		Name:       "Admin",
		Email:      "admin@thc.local",
		Role:       domain.RoleAdmin,
		LocationID: &loc,
		Status:     domain.UserStatusActive,
		Type:       domain.UserTypeInternal,
	}
}

func validParser() *fakeParser {
	loc := domain.UUID("loc-1")
	claims := infraJWT.Claims{
		Role:       domain.RoleAdmin,
		LocationID: &loc,
	}
	claims.Subject = "user-1"
	return &fakeParser{claims: claims}
}

func withTestIdentity(id deliveryhttp.Identity) gin.HandlerFunc {
	return func(c *gin.Context) {
		deliveryhttp.WithIdentity(c, id)
		c.Next()
	}
}

func okHandler(c *gin.Context) {
	c.Status(http.StatusOK)
}

func TestJWT_MissingTokenIs401(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/me", middleware.JWT(validParser(), &fakeLoader{profile: activeProfile()}), okHandler)

	req := httptest.NewRequest(http.MethodGet, "/me", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("missing token status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
	assertFailureEnvelope(t, rec.Body.String())
}

func TestJWT_MalformedTokenIs401(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	parser := &fakeParser{err: context.DeadlineExceeded}
	r.GET("/me", middleware.JWT(parser, &fakeLoader{profile: activeProfile()}), okHandler)

	req := httptest.NewRequest(http.MethodGet, "/me", nil)
	req.Header.Set("Authorization", "Bearer not.a.token")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("malformed token status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestJWT_DeactivatedAccountCannotReuseToken(t *testing.T) {
	gin.SetMode(gin.TestMode)
	dead := activeProfile()
	dead.Status = domain.UserStatusInactive
	r := gin.New()
	r.GET("/me", middleware.JWT(validParser(), &fakeLoader{profile: dead}), okHandler)

	req := httptest.NewRequest(http.MethodGet, "/me", nil)
	req.Header.Set("Authorization", "Bearer valid.token.here")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("deactivated account status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestJWT_ValidTokenStoresIdentity(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/me",
		middleware.JWT(validParser(), &fakeLoader{profile: activeProfile()}),
		func(c *gin.Context) {
			id, ok := deliveryhttp.IdentityFrom(c)
			if !ok || id.UserID != "user-1" || id.Role != domain.RoleAdmin {
				c.Status(http.StatusTeapot)
				return
			}
			c.Status(http.StatusOK)
		},
	)

	req := httptest.NewRequest(http.MethodGet, "/me", nil)
	req.Header.Set("Authorization", "Bearer valid.token.here")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("valid token status = %d, want %d", rec.Code, http.StatusOK)
	}
}

func TestRBAC_VendorCannotReachAdminRoutes(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/users/security",
		withTestIdentity(deliveryhttp.Identity{UserID: "vendor-1", Role: domain.RoleVendor}),
		middleware.RequireRoles(domain.RoleSuperAdmin, domain.RoleAdmin),
		okHandler,
	)

	req := httptest.NewRequest(http.MethodGet, "/users/security", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("vendor on admin route status = %d, want %d", rec.Code, http.StatusForbidden)
	}
	assertForbiddenBranchMessage(t, rec.Body.String())
}

func TestRBAC_SecurityCannotReachUserManagement(t *testing.T) {
	gin.SetMode(gin.TestMode)
	loc := domain.UUID("loc-1")
	r := gin.New()
	r.GET("/users/security",
		withTestIdentity(deliveryhttp.Identity{UserID: "sec-1", Role: domain.RoleSecurity, LocationID: &loc}),
		middleware.RequireRoles(domain.RoleSuperAdmin, domain.RoleAdmin),
		okHandler,
	)

	req := httptest.NewRequest(http.MethodGet, "/users/security", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("security on user-mgmt status = %d, want %d", rec.Code, http.StatusForbidden)
	}
	assertForbiddenBranchMessage(t, rec.Body.String())
}

// failureBody mirrors the mandated failure envelope.
type failureBody struct {
	Success bool `json:"success"`
	Error   *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func assertFailureEnvelope(t *testing.T, raw string) {
	t.Helper()
	var body failureBody
	if err := json.Unmarshal([]byte(raw), &body); err != nil {
		t.Fatalf("not a valid envelope: %v: %q", err, raw)
	}
	if body.Success {
		t.Fatalf("success must be false: %q", raw)
	}
	if body.Error == nil || body.Error.Code == "" || body.Error.Message == "" {
		t.Fatalf("failure envelope needs code+message: %q", raw)
	}
}

func assertForbiddenBranchMessage(t *testing.T, raw string) {
	t.Helper()
	var body failureBody
	if err := json.Unmarshal([]byte(raw), &body); err != nil {
		t.Fatalf("not a valid envelope: %v: %q", err, raw)
	}
	if body.Error == nil {
		t.Fatalf("missing error body: %q", raw)
	}
	if body.Error.Message != domain.ErrForbiddenBranch.Error() {
		t.Fatalf("message = %q, want sentinel %q", body.Error.Message, domain.ErrForbiddenBranch.Error())
	}
	if !strings.Contains(raw, `"success":false`) {
		t.Fatalf("must be the failure envelope: %q", raw)
	}
}

func TestRBAC_DevSuperadminPassesWhereSuperAdminAllowed(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, allowed := range [][]domain.RoleName{
		{domain.RoleSuperAdmin},
		{domain.RoleSuperAdmin, domain.RoleAdmin},
		{domain.RoleSecurity, domain.RoleAdmin, domain.RoleSuperAdmin},
	} {
		r := gin.New()
		r.GET("/backoffice",
			withTestIdentity(deliveryhttp.Identity{UserID: "dev-1", Role: domain.RoleDevSuperAdmin}),
			middleware.RequireRoles(allowed...),
			okHandler,
		)
		req := httptest.NewRequest(http.MethodGet, "/backoffice", nil)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("dev-superadmin on super_admin route %v status = %d, want %d", allowed, rec.Code, http.StatusOK)
		}
	}

	r := gin.New()
	r.GET("/security-only",
		withTestIdentity(deliveryhttp.Identity{UserID: "dev-1", Role: domain.RoleDevSuperAdmin}),
		middleware.RequireRoles(domain.RoleSecurity),
		okHandler,
	)
	req := httptest.NewRequest(http.MethodGet, "/security-only", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("dev-superadmin on security-only route status = %d, want %d", rec.Code, http.StatusForbidden)
	}
	assertForbiddenBranchMessage(t, rec.Body.String())
}

func TestBranchScope_AdminCannotReadForeignBranch(t *testing.T) {
	own := domain.UUID("loc-own")
	foreign := domain.UUID("loc-foreign")
	id := deliveryhttp.Identity{UserID: "adm-1", Role: domain.RoleAdmin, LocationID: &own}
	if err := middleware.CheckBranch(id, foreign); err == nil {
		t.Fatal("admin touching a foreign branch must be refused")
	} else if err.Error() != domain.ErrForbiddenBranch.Error() {
		t.Fatalf("branch error = %q, want sentinel %q", err.Error(), domain.ErrForbiddenBranch.Error())
	}
	if err := middleware.CheckBranch(id, own); err != nil {
		t.Fatalf("admin touching its own branch must pass, got %v", err)
	}
	superID := deliveryhttp.Identity{UserID: "root", Role: domain.RoleSuperAdmin}
	if err := middleware.CheckBranch(superID, foreign); err != nil {
		t.Fatalf("super_admin bypass must pass, got %v", err)
	}
}

func TestBranchScope_DevSuperadminBypassesLikeSuperAdmin(t *testing.T) {
	foreign := domain.UUID("loc-foreign")
	narrowed := domain.UUID("loc-narrow")
	for _, role := range []domain.RoleName{domain.RoleSuperAdmin, domain.RoleDevSuperAdmin} {
		id := deliveryhttp.Identity{UserID: "root", Role: role}
		if err := middleware.CheckBranch(id, foreign); err != nil {
			t.Fatalf("role %s bypass must pass, got %v", role, err)
		}
		scope, err := middleware.EffectiveScope(id, "")
		if err != nil || scope != nil {
			t.Fatalf("role %s global scope must be nil,nil, got %v,%v", role, scope, err)
		}
		scope, err = middleware.EffectiveScope(id, string(narrowed))
		if err != nil || scope == nil || *scope != narrowed {
			t.Fatalf("role %s narrowed scope must pass through, got %v,%v", role, scope, err)
		}
	}
}

func TestRateLimiter_BlocksAfterConfiguredAttempts(t *testing.T) {
	gin.SetMode(gin.TestMode)
	limiter := middleware.NewRateLimiter(2, time.Minute)
	r := gin.New()
	r.POST("/auth/login", limiter.Middleware(), okHandler)

	serve := func() int {
		req := httptest.NewRequest(http.MethodPost, "/auth/login", nil)
		req.RemoteAddr = "10.0.0.9:1234"
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec.Code
	}
	if code := serve(); code != http.StatusOK {
		t.Fatalf("attempt 1 = %d, want 200", code)
	}
	if code := serve(); code != http.StatusOK {
		t.Fatalf("attempt 2 = %d, want 200", code)
	}
	if code := serve(); code != http.StatusTooManyRequests {
		t.Fatalf("attempt 3 = %d, want 429", code)
	}
}
