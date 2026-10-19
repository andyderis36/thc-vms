package handlers_test

import (
	"testing"

	"thc-vms/backend/internal/domain"
)

// RED proof: GET /visits?sort_by=&order= must reach the usecase.
// Fails before the fix (handler never parses the pair, fields stay default).
func TestListVisits_ParsesSortParamsRED(t *testing.T) {
	cases := []struct {
		name  string
		path  string
		sort  string
		order string
	}{
		{"created_at desc", "/visits?sort_by=created_at&order=desc", "created_at", "desc"},
		{"created_at asc", "/visits?sort_by=created_at&order=asc", "created_at", "asc"},
		{"start_date desc", "/visits?sort_by=start_date&order=desc", "start_date", "desc"},
		{"start_date asc", "/visits?sort_by=start_date&order=asc", "start_date", "asc"},
		{"end_date desc", "/visits?sort_by=end_date&order=desc", "end_date", "desc"},
		{"end_date asc", "/visits?sort_by=end_date&order=asc", "end_date", "asc"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc := &fakeVisitService{}
			engine := newVisitEngine(svc, domain.RoleSuperAdmin, "")
			rec := serve(engine, "GET", tc.path, nil, "")
			mustStatus(t, rec, 200)
			mustSuccess(t, rec)
			if string(svc.lastListIn.SortBy) != tc.sort {
				t.Fatalf("RED: SortBy=%q reached usecase, want %q", svc.lastListIn.SortBy, tc.sort)
			}
			if string(svc.lastListIn.Order) != tc.order {
				t.Fatalf("RED: Order=%q reached usecase, want %q", svc.lastListIn.Order, tc.order)
			}
		})
	}
}

// Default listing keeps legacy behaviour: created_at desc.
func TestListVisits_DefaultSortIsCreatedAtDesc(t *testing.T) {
	svc := &fakeVisitService{}
	engine := newVisitEngine(svc, domain.RoleSuperAdmin, "")
	rec := serve(engine, "GET", "/visits", nil, "")
	mustStatus(t, rec, 200)
	mustSuccess(t, rec)
	if string(svc.lastListIn.SortBy) != "created_at" {
		t.Fatalf("SortBy=%q, want created_at default", svc.lastListIn.SortBy)
	}
	if string(svc.lastListIn.Order) != "desc" {
		t.Fatalf("Order=%q, want desc default", svc.lastListIn.Order)
	}
}

// Invalid sort/order is a 400 VALIDATION_ERROR, never a silent listing.
func TestListVisits_RejectsInvalidSort(t *testing.T) {
	for _, path := range []string{
		"/visits?sort_by=visit_id",
		"/visits?sort_by=created_at;DROP",
		"/visits?order=sideways",
		"/visits?sort_by=start_date&order=up",
		"/visits?sort_by=bogus&order=bogus",
	} {
		svc := &fakeVisitService{}
		engine := newVisitEngine(svc, domain.RoleSuperAdmin, "")
		rec := serve(engine, "GET", path, nil, "")
		mustStatus(t, rec, 400)
		env := decodeEnvelope(t, rec)
		if env.Success {
			t.Fatalf("path %s: success=true, want false envelope", path)
		}
		if env.Error == nil || env.Error.Code != "VALIDATION_ERROR" {
			t.Fatalf("path %s: error=%+v, want code VALIDATION_ERROR", path, env.Error)
		}
	}
}

// Sort composes with ?q= and the date window: no regression on Wave 1-2.
func TestListVisits_SortKeepsQAndDate(t *testing.T) {
	svc := &fakeVisitService{}
	engine := newVisitEngine(svc, domain.RoleSuperAdmin, "")
	rec := serve(engine, "GET", "/visits?q=Budi&date_from=2026-10-01&date_to=2026-10-03&sort_by=start_date&order=asc", nil, "")
	mustStatus(t, rec, 200)
	mustSuccess(t, rec)
	if svc.lastListIn.Search != "Budi" {
		t.Fatalf("Search=%q, want Budi (?q= regresi saat sort aktif)", svc.lastListIn.Search)
	}
	if svc.lastListIn.From == nil || svc.lastListIn.To == nil {
		t.Fatalf("From=%v To=%v, want both set bersama sort", svc.lastListIn.From, svc.lastListIn.To)
	}
	if string(svc.lastListIn.SortBy) != "start_date" || string(svc.lastListIn.Order) != "asc" {
		t.Fatalf("SortBy=%q Order=%q, want start_date/asc", svc.lastListIn.SortBy, svc.lastListIn.Order)
	}
}
