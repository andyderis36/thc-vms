package handlers_test

import (
	"testing"

	"thc-vms/backend/internal/domain"
)

// RED proof: GET /visits?q=Budi must reach the usecase as Search.
// Fails to COMPILE before the fix (no Search field on ListVisitsInput).
func TestListVisits_ParsesQParamRED(t *testing.T) {
	svc := &fakeVisitService{}
	engine := newVisitEngine(svc, domain.RoleSuperAdmin, "")

	rec := serve(engine, "GET", "/visits?q=Budi", nil, "")
	mustStatus(t, rec, 200)
	mustSuccess(t, rec)
	if svc.lastListIn.Search != "Budi" {
		t.Fatalf("RED: Search=%q reached usecase, want %q (?q= diabaikan BE)", svc.lastListIn.Search, "Budi")
	}
}

// Empty/absent q keeps legacy behaviour: unfiltered listing.
func TestListVisits_EmptyQMeansUnfiltered(t *testing.T) {
	svc := &fakeVisitService{}
	engine := newVisitEngine(svc, domain.RoleSuperAdmin, "")

	for _, path := range []string{"/visits", "/visits?q=", "/visits?q=++"} {
		svc.lastListIn.Search = "STALE"
		rec := serve(engine, "GET", path, nil, "")
		mustStatus(t, rec, 200)
		mustSuccess(t, rec)
		if svc.lastListIn.Search != "" {
			t.Fatalf("path %s: Search=%q, want empty (legacy unfiltered)", path, svc.lastListIn.Search)
		}
	}
}
