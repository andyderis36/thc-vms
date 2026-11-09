package middleware_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	deliveryhttp "thc-vms/backend/internal/delivery/http"
	"thc-vms/backend/internal/delivery/http/middleware"
	"thc-vms/backend/internal/domain"
)

// Scope-after-removal race: the JWT middleware resolves the branch union once
// per request with no caching, so a branch detached between two requests
// takes effect on the NEXT request. The probe handler decides CheckBranchFor
// for the removed branch on the live request context: allow before removal,
// fail-closed after. Stale scope would keep allowing; a widened fallback
// would 500 — the want is exactly [allow, deny] with narrowed stashes.
func TestJWT_ReresolvesScopeAfterBranchRemoval(t *testing.T) {
	gin.SetMode(gin.TestMode)
	locA := domain.UUID("loc-a")
	locB := domain.UUID("loc-b")
	profile := activeProfile()
	store := &fakeScopeStore{rows: map[domain.UUID][]domain.UUID{
		profile.ID: {locA, locB},
	}}

	var stashes [][]domain.UUID
	var decisions []bool
	r := gin.New()
	r.GET("/probe",
		middleware.JWT(validParser(), &fakeLoader{profile: profile}, store),
		func(c *gin.Context) {
			scope, ok := deliveryhttp.ScopeFrom(c)
			if !ok {
				c.Status(http.StatusTeapot)
				return
			}
			stashes = append(stashes, append([]domain.UUID(nil), scope.LocationIDs...))
			decisions = append(decisions, middleware.CheckBranchFor(c, locB) == nil)
			c.Status(http.StatusOK)
		},
	)
	serve := func() int {
		req := httptest.NewRequest(http.MethodGet, "/probe", nil)
		req.Header.Set("Authorization", "Bearer valid.token.here")
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec.Code
	}

	if code := serve(); code != http.StatusOK {
		t.Fatalf("first request status = %d, want %d", code, http.StatusOK)
	}
	// Branch B is detached mid-session: the next request must resolve {A}.
	store.rows[profile.ID] = []domain.UUID{locA}
	if code := serve(); code != http.StatusOK {
		t.Fatalf("second request status = %d, want %d", code, http.StatusOK)
	}

	if len(decisions) != 2 {
		t.Fatalf("decisions = %v, want exactly two probe decisions", decisions)
	}
	if !decisions[0] {
		t.Fatal("pre-removal CheckBranchFor(B) denied: union not stashed on the live request")
	}
	if decisions[1] {
		t.Fatal("post-removal CheckBranchFor(B) allowed: stale scope survived the branch removal")
	}
	if len(stashes[0]) != 2 || len(stashes[1]) != 1 || stashes[1][0] != locA {
		t.Fatalf("stashes = %v, want [{A B} {A}] in request order", stashes)
	}
	if store.calls != 2 {
		t.Fatalf("store touches = %d, want 2 (exactly one resolution per request, no cache)", store.calls)
	}
}
