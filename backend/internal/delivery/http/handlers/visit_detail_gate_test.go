package handlers_test

import (
	"encoding/json"
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
)

// enrichedVisit is a visiting request carrying gate timestamps, as the usecase
// withGateTimes produces for GET /visits/{id}.
func enrichedVisit() domain.VisitRequest {
	v := cannedVisit()
	v.Status = domain.VisitStatusVisiting
	inAt := time.Date(2026, time.September, 26, 7, 30, 0, 0, time.UTC)
	outAt := time.Date(2026, time.September, 26, 15, 5, 0, 0, time.UTC)
	by := domain.UUID("sec-1")
	v.CheckInAt = &inAt
	v.CheckOutAt = &outAt
	v.CheckedInBy = &by
	return v
}

// A visiting single-GET renders check_in_at/check_out_at as RFC3339 plus the
// acting staff id, inside the unchanged {success, data} envelope.
func TestGetVisit_RendersGateTimesWhenPresent(t *testing.T) {
	svc := &fakeVisitService{visitByKey: map[string]domain.VisitRequest{"visit-1": enrichedVisit()}}
	engine := newVisitEngine(svc, domain.RoleAdmin, "loc-A")

	rec := serve(engine, "GET", "/visits/visit-1", nil, "")
	mustStatus(t, rec, 200)
	detail := asObject(t, mustSuccess(t, rec).Data)
	assertSubset(t, "VisitDetail", detail)

	for _, key := range []string{"check_in_at", "check_out_at"} {
		raw, ok := detail[key].(string)
		if !ok || raw == "" {
			t.Fatalf("%s must be a non-empty string, got %v", key, detail[key])
		}
		if _, err := time.Parse(time.RFC3339, raw); err != nil {
			t.Errorf("%s = %q is not RFC3339: %v", key, raw, err)
		}
	}
	if got, want := detail["checked_in_by"], "sec-1"; got != want {
		t.Errorf("checked_in_by = %v, want %q", got, want)
	}
}

// Requested/approved visits (and every list item, which the usecase never
// enriches) omit the gate keys entirely via omitempty.
func TestGetVisit_OmitsGateTimesWhenAbsent(t *testing.T) {
	svc := &fakeVisitService{
		listItems:  []domain.VisitRequest{cannedVisit()},
		listTotal:  1,
		visitByKey: map[string]domain.VisitRequest{"visit-1": cannedVisit()},
	}
	engine := newVisitEngine(svc, domain.RoleAdmin, "loc-A")

	for _, path := range []string{"/visits/visit-1", "/visits"} {
		rec := serve(engine, "GET", path, nil, "")
		mustStatus(t, rec, 200)
		var detail map[string]any
		if path == "/visits" {
			var page struct {
				Items []map[string]any `json:"items"`
			}
			if err := json.Unmarshal(mustSuccess(t, rec).Data, &page); err != nil || len(page.Items) != 1 {
				t.Fatalf("list shape wrong: %v: %q", err, mustSuccess(t, rec).Data)
			}
			detail = page.Items[0]
		} else {
			detail = asObject(t, mustSuccess(t, rec).Data)
		}
		for _, key := range []string{"check_in_at", "check_out_at", "checked_in_by"} {
			if _, present := detail[key]; present {
				t.Errorf("%s: gate key must be absent without enrichment, got %v", path, detail[key])
			}
		}
	}
}
