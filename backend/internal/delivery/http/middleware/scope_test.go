package middleware_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	deliveryhttp "thc-vms/backend/internal/delivery/http"
	"thc-vms/backend/internal/delivery/http/middleware"
	"thc-vms/backend/internal/domain"
)

// fakeScopeStore is a hand-written ScopeStore double: no mocking library. rows
// maps a user id to its user_locations union; err fails every lookup so the
// fail-closed path can be exercised; calls counts store touches so the
// global/vendor no-touch rule is provable.
type fakeScopeStore struct {
	rows     map[domain.UUID][]domain.UUID
	err      error
	calls    int
	lastUser domain.UUID
}

func (f *fakeScopeStore) ListUserLocationIDs(_ context.Context, userID domain.UUID) ([]domain.UUID, error) {
	f.calls++
	f.lastUser = userID
	if f.err != nil {
		return nil, f.err
	}
	return f.rows[userID], nil
}

// TestAccessibleLocationIDs_Matrix pins the resolver contract: super_admin and
// dev-superadmin resolve global without touching the join table, vendor
// resolves non-global without touching it (owner path untouched downstream),
// and every other role resolves exactly its user_locations union.
func TestAccessibleLocationIDs_Matrix(t *testing.T) {
	locA := domain.UUID("loc-a")
	locB := domain.UUID("loc-b")
	adminID := domain.UUID("adm-1")
	secID := domain.UUID("sec-1")
	ghostID := domain.UUID("ghost-1")
	store := &fakeScopeStore{rows: map[domain.UUID][]domain.UUID{
		adminID: {locA, locB},
		secID:   {locA},
	}}

	cases := []struct {
		name       string
		id         deliveryhttp.Identity
		wantIDs    []domain.UUID
		wantGlobal bool
		wantCalls  int
	}{
		{
			name:       "super_admin is global without store touch",
			id:         deliveryhttp.Identity{UserID: "root", Role: domain.RoleSuperAdmin},
			wantIDs:    nil,
			wantGlobal: true,
			wantCalls:  0,
		},
		{
			name:       "dev-superadmin is global without store touch",
			id:         deliveryhttp.Identity{UserID: "dev-1", Role: domain.RoleDevSuperAdmin},
			wantIDs:    nil,
			wantGlobal: true,
			wantCalls:  0,
		},
		{
			name:       "vendor is non-global without store touch",
			id:         deliveryhttp.Identity{UserID: "ven-1", Role: domain.RoleVendor},
			wantIDs:    nil,
			wantGlobal: false,
			wantCalls:  0,
		},
		{
			name:       "admin resolves multi-branch union",
			id:         deliveryhttp.Identity{UserID: adminID, Role: domain.RoleAdmin, LocationID: &locA},
			wantIDs:    []domain.UUID{locA, locB},
			wantGlobal: false,
			wantCalls:  1,
		},
		{
			name:       "security resolves single-branch union",
			id:         deliveryhttp.Identity{UserID: secID, Role: domain.RoleSecurity, LocationID: &locA},
			wantIDs:    []domain.UUID{locA},
			wantGlobal: false,
			wantCalls:  1,
		},
		{
			name:       "unknown user resolves empty non-global scope",
			id:         deliveryhttp.Identity{UserID: ghostID, Role: domain.RoleAdmin},
			wantIDs:    nil,
			wantGlobal: false,
			wantCalls:  1,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			before := store.calls
			ids, isGlobal, err := middleware.AccessibleLocationIDs(context.Background(), tc.id, store)
			if err != nil {
				t.Fatalf("resolver err = %v, want nil", err)
			}
			if isGlobal != tc.wantGlobal {
				t.Fatalf("isGlobal = %v, want %v", isGlobal, tc.wantGlobal)
			}
			if len(ids) != len(tc.wantIDs) {
				t.Fatalf("ids = %v, want %v", ids, tc.wantIDs)
			}
			for i := range ids {
				if ids[i] != tc.wantIDs[i] {
					t.Fatalf("ids = %v, want %v", ids, tc.wantIDs)
				}
			}
			if got := store.calls - before; got != tc.wantCalls {
				t.Fatalf("store touches = %d, want %d", got, tc.wantCalls)
			}
			if tc.wantCalls == 1 && store.lastUser != tc.id.UserID {
				t.Fatalf("store looked up %q, want actor %q", store.lastUser, tc.id.UserID)
			}
		})
	}
}

// TestAccessibleLocationIDs_FailClosed pins the deny-on-error rule: a store
// failure surfaces an error and never a widened scope, so callers refuse.
func TestAccessibleLocationIDs_FailClosed(t *testing.T) {
	boom := errors.New("scope store down")
	store := &fakeScopeStore{err: boom}
	loc := domain.UUID("loc-a")
	id := deliveryhttp.Identity{UserID: "adm-1", Role: domain.RoleAdmin, LocationID: &loc}
	ids, isGlobal, err := middleware.AccessibleLocationIDs(context.Background(), id, store)
	if err == nil {
		t.Fatal("resolver err = nil, want the store failure")
	}
	if isGlobal {
		t.Fatalf("isGlobal = true on store failure, must fail closed")
	}
	if len(ids) != 0 {
		t.Fatalf("ids = %v on store failure, want empty", ids)
	}
}

// scopeTestContext seeds a gin context the way the JWT middleware leaves it:
// identity always, scope stash only when wantStash.
func scopeTestContext(id deliveryhttp.Identity, scope deliveryhttp.Scope, wantStash bool) *gin.Context {
	gin.SetMode(gin.TestMode)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	deliveryhttp.WithIdentity(c, id)
	if wantStash {
		deliveryhttp.WithScope(c, scope)
	}
	return c
}

// TestCheckBranchFor_WithoutStashMatchesScalar pins the no-stash fallback:
// without a stash the request-aware guard decides exactly like CheckBranch,
// so routes and test doubles that seed identity only keep byte-identical
// behaviour.
func TestCheckBranchFor_WithoutStashMatchesScalar(t *testing.T) {
	own := domain.UUID("loc-own")
	foreign := domain.UUID("loc-foreign")
	ids := []deliveryhttp.Identity{
		{UserID: "root", Role: domain.RoleSuperAdmin},
		{UserID: "dev-1", Role: domain.RoleDevSuperAdmin},
		{UserID: "adm-1", Role: domain.RoleAdmin, LocationID: &own},
		{UserID: "sec-1", Role: domain.RoleSecurity, LocationID: &own},
		{UserID: "noloc-1", Role: domain.RoleAdmin},
		{UserID: "ven-1", Role: domain.RoleVendor},
	}
	for _, id := range ids {
		for _, target := range []domain.UUID{own, foreign} {
			want := middleware.CheckBranch(id, target)
			got := middleware.CheckBranchFor(scopeTestContext(id, deliveryhttp.Scope{}, false), target)
			if (want == nil) != (got == nil) {
				t.Fatalf("role %s target %s: CheckBranch=%v, CheckBranchFor=%v, must agree without stash",
					id.Role, target, want, got)
			}
		}
	}
}

// TestCheckBranchFor_WithStashWidensToUnion pins the stash wiring for the
// branch write paths: a target inside the stashed union passes even when it
// differs from the scalar primary, while anything outside both still fails
// closed. The empty-union case falls back to the scalar primary so accounts
// whose coverage rows are not yet written keep working through the hybrid
// transition.
func TestCheckBranchFor_WithStashWidensToUnion(t *testing.T) {
	primary := domain.UUID("loc-primary")
	covered := domain.UUID("loc-covered")
	stranger := domain.UUID("loc-stranger")
	id := deliveryhttp.Identity{UserID: "adm-1", Role: domain.RoleAdmin, LocationID: &primary}

	if err := middleware.CheckBranchFor(
		scopeTestContext(id, deliveryhttp.Scope{LocationIDs: []domain.UUID{primary, covered}}, true), covered); err != nil {
		t.Fatalf("union member must pass, got %v", err)
	}
	if err := middleware.CheckBranchFor(
		scopeTestContext(id, deliveryhttp.Scope{LocationIDs: []domain.UUID{primary, covered}}, true), stranger); err == nil {
		t.Fatal("branch outside union and primary must be refused")
	} else if err.Error() != domain.ErrForbiddenBranch.Error() {
		t.Fatalf("refusal = %q, want sentinel %q", err.Error(), domain.ErrForbiddenBranch.Error())
	}
	if err := middleware.CheckBranchFor(
		scopeTestContext(id, deliveryhttp.Scope{}, true), primary); err != nil {
		t.Fatalf("empty union must fall back to the scalar primary, got %v", err)
	}
}

// TestCheckBranchFor_AnonymousIsUnauthorized pins the fail-closed entry:
// no identity means no scope decision at all.
func TestCheckBranchFor_AnonymousIsUnauthorized(t *testing.T) {
	gin.SetMode(gin.TestMode)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	if err := middleware.CheckBranchFor(c, domain.UUID("loc-a")); err == nil {
		t.Fatal("anonymous CheckBranchFor must fail, got nil")
	}
}

// TestJWT_StashesBranchUnion pins the per-request resolution: one request
// performs exactly one store lookup and the handler observes the stashed
// union, never a per-row lookup.
func TestJWT_StashesBranchUnion(t *testing.T) {
	gin.SetMode(gin.TestMode)
	locA := domain.UUID("loc-a")
	locB := domain.UUID("loc-b")
	profile := activeProfile()
	store := &fakeScopeStore{rows: map[domain.UUID][]domain.UUID{
		profile.ID: {locA, locB},
	}}

	r := gin.New()
	r.GET("/me",
		middleware.JWT(validParser(), &fakeLoader{profile: profile}, store),
		func(c *gin.Context) {
			scope, ok := deliveryhttp.ScopeFrom(c)
			if !ok {
				c.Status(http.StatusTeapot)
				return
			}
			if scope.IsGlobal || len(scope.LocationIDs) != 2 {
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
		t.Fatalf("stashed request status = %d, want %d", rec.Code, http.StatusOK)
	}
	if store.calls != 1 {
		t.Fatalf("store touches per request = %d, want exactly 1", store.calls)
	}
}

// TestJWT_GlobalAndVendorSkipStore pins the early returns inside the
// middleware: super_admin, dev-superadmin and vendor stash their scope
// without the join table being read at all.
func TestJWT_GlobalAndVendorSkipStore(t *testing.T) {
	gin.SetMode(gin.TestMode)
	cases := []struct {
		name       string
		role       domain.RoleName
		wantGlobal bool
	}{
		{name: "super_admin", role: domain.RoleSuperAdmin, wantGlobal: true},
		{name: "dev-superadmin", role: domain.RoleDevSuperAdmin, wantGlobal: true},
		{name: "vendor", role: domain.RoleVendor, wantGlobal: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			profile := activeProfile()
			profile.Role = tc.role
			profile.LocationID = nil
			parser := validParser()
			parser.claims.Role = tc.role
			parser.claims.LocationID = nil
			store := &fakeScopeStore{}

			r := gin.New()
			r.GET("/me",
				middleware.JWT(parser, &fakeLoader{profile: profile}, store),
				func(c *gin.Context) {
					scope, ok := deliveryhttp.ScopeFrom(c)
					if !ok || scope.IsGlobal != tc.wantGlobal || len(scope.LocationIDs) != 0 {
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
				t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
			}
			if store.calls != 0 {
				t.Fatalf("store touches = %d, want 0 (early return)", store.calls)
			}
		})
	}
}

// TestJWT_ScopeLookupFailureIs401 pins the middleware fail-closed rule: a
// branch actor whose coverage cannot be resolved is refused, never admitted
// with an empty or widened scope.
func TestJWT_ScopeLookupFailureIs401(t *testing.T) {
	gin.SetMode(gin.TestMode)
	store := &fakeScopeStore{err: errors.New("user_locations unreadable")}
	r := gin.New()
	r.GET("/me", middleware.JWT(validParser(), &fakeLoader{profile: activeProfile()}, store), okHandler)

	req := httptest.NewRequest(http.MethodGet, "/me", nil)
	req.Header.Set("Authorization", "Bearer valid.token.here")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("scope failure status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
	assertFailureEnvelope(t, rec.Body.String())
}
