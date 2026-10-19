package handlers_test

import (
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
)

// RED proof: GET /visits?date_from=&date_to= (date-only, inklusif) must reach
// the usecase as From/To. Fails before the fix (handler never parses the pair,
// From/To stay nil): window diisi tapi tak terfilter.
func TestListVisits_ParsesDateOnlyRangeRED(t *testing.T) {
	svc := &fakeVisitService{}
	engine := newVisitEngine(svc, domain.RoleSuperAdmin, "")

	rec := serve(engine, "GET", "/visits?date_from=2026-10-01&date_to=2026-10-03", nil, "")
	mustStatus(t, rec, 200)
	mustSuccess(t, rec)
	if svc.lastListIn.From == nil || svc.lastListIn.To == nil {
		t.Fatalf("RED: From=%v To=%v, want both set (window diisi tapi tak terfilter)", svc.lastListIn.From, svc.lastListIn.To)
	}
	wantFrom := time.Date(2026, time.October, 1, 0, 0, 0, 0, time.UTC)
	if !svc.lastListIn.From.Equal(wantFrom) {
		t.Fatalf("From=%v, want %v (date-only = midnight UTC)", svc.lastListIn.From, wantFrom)
	}
	// Inklusif: date-only date_to mencakup sehari penuh, jadi batas atas
	// eksklusif SQL (< date_to) digeser +24 jam -> 2026-10-04T00:00:00Z.
	wantTo := time.Date(2026, time.October, 4, 0, 0, 0, 0, time.UTC)
	if !svc.lastListIn.To.Equal(wantTo) {
		t.Fatalf("To=%v, want %v (date-only inklusif = +1 hari)", svc.lastListIn.To, wantTo)
	}
}

// RFC3339 (dengan offset TZ) diteruskan sebagai instan yang tepat (TZ-safe:
// offset dipertahankan, bukan dipotong ke midnight).
func TestListVisits_ParsesRFC3339Range(t *testing.T) {
	svc := &fakeVisitService{}
	engine := newVisitEngine(svc, domain.RoleSuperAdmin, "")

	rec := serve(engine, "GET", "/visits?date_from=2026-10-01T09:00:00%2B07:00&date_to=2026-10-03T17:00:00Z", nil, "")
	mustStatus(t, rec, 200)
	mustSuccess(t, rec)
	if svc.lastListIn.From == nil || svc.lastListIn.To == nil {
		t.Fatalf("From=%v To=%v, want both set (RFC3339 tak terfilter)", svc.lastListIn.From, svc.lastListIn.To)
	}
	wantFrom := time.Date(2026, time.October, 1, 9, 0, 0, 0, time.FixedZone("UTC+7", 7*3600))
	if !svc.lastListIn.From.Equal(wantFrom) {
		t.Fatalf("From=%v, want %v (offset +07:00 wajib dipertahankan)", svc.lastListIn.From, wantFrom)
	}
	wantTo := time.Date(2026, time.October, 3, 17, 0, 0, 0, time.UTC)
	if !svc.lastListIn.To.Equal(wantTo) {
		t.Fatalf("To=%v, want %v (RFC3339 diteruskan tepat)", svc.lastListIn.To, wantTo)
	}
}

// Tanggal tak terbaca = 400 envelope VALIDATION_ERROR, bukan listing senyap.
func TestListVisits_RejectsInvalidDate(t *testing.T) {
	for _, path := range []string{
		"/visits?date_from=bukan-tanggal",
		"/visits?date_to=2026-13-99",
		"/visits?date_from=2026-10-01&date_to=kapan",
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

// Range terbalik (from > to) ditolak 400, bukan menukar diam-diam.
func TestListVisits_RejectsReversedRange(t *testing.T) {
	svc := &fakeVisitService{}
	engine := newVisitEngine(svc, domain.RoleSuperAdmin, "")

	rec := serve(engine, "GET", "/visits?date_from=2026-10-03&date_to=2026-10-01", nil, "")
	mustStatus(t, rec, 400)
	env := decodeEnvelope(t, rec)
	if env.Success {
		t.Fatalf("success=true, want false envelope untuk range terbalik")
	}
	if env.Error == nil || env.Error.Code != "VALIDATION_ERROR" {
		t.Fatalf("error=%+v, want code VALIDATION_ERROR", env.Error)
	}
}

// Tanpa pair tanggal = listing legacy tanpa filter; ?q= Wave 1 tak regresi
// saat digabung dengan window tanggal.
func TestListVisits_DateFilterKeepsQAndEmpty(t *testing.T) {
	svc := &fakeVisitService{}
	engine := newVisitEngine(svc, domain.RoleSuperAdmin, "")

	rec := serve(engine, "GET", "/visits?q=Budi&date_from=2026-10-01&date_to=2026-10-03", nil, "")
	mustStatus(t, rec, 200)
	mustSuccess(t, rec)
	if svc.lastListIn.Search != "Budi" {
		t.Fatalf("Search=%q, want Budi (?q= regresi saat window aktif)", svc.lastListIn.Search)
	}
	if svc.lastListIn.From == nil || svc.lastListIn.To == nil {
		t.Fatalf("From=%v To=%v, want both set bersama ?q=", svc.lastListIn.From, svc.lastListIn.To)
	}

	svc2 := &fakeVisitService{}
	engine2 := newVisitEngine(svc2, domain.RoleSuperAdmin, "")
	rec2 := serve(engine2, "GET", "/visits", nil, "")
	mustStatus(t, rec2, 200)
	mustSuccess(t, rec2)
	if svc2.lastListIn.From != nil || svc2.lastListIn.To != nil {
		t.Fatalf("From=%v To=%v, want both nil (tanpa pair = unfiltered)", svc2.lastListIn.From, svc2.lastListIn.To)
	}
}
