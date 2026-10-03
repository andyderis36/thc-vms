package handlers_test

import (
	"encoding/json"
	"testing"

	"thc-vms/backend/internal/domain"
)

// visitWithPurposes is the canned visit carrying two catalogue purposes, as
// the repository now attaches on reads.
func visitWithPurposes() domain.VisitRequest {
	v := cannedVisit()
	v.Purposes = []domain.Purpose{
		{ID: "pur-1", Name: "Maintenance Genset", IsActive: true},
		{ID: "pur-2", Name: "Troubleshoot FO", IsActive: true},
	}
	return v
}

// Single-GET and list items render purposes as [{id, name}] inside the
// unchanged {success, data} envelope.
func TestGetVisit_RendersPurposesFromDomain(t *testing.T) {
	svc := &fakeVisitService{
		listItems:  []domain.VisitRequest{visitWithPurposes()},
		listTotal:  1,
		visitByKey: map[string]domain.VisitRequest{"visit-1": visitWithPurposes()},
	}
	engine := newVisitEngine(svc, domain.RoleAdmin, "loc-A")

	rec := serve(engine, "GET", "/visits/visit-1", nil, "")
	mustStatus(t, rec, 200)
	detail := asObject(t, mustSuccess(t, rec).Data)
	assertSubset(t, "VisitDetail", detail)
	assertPurposes(t, detail, map[string]string{"pur-1": "Maintenance Genset", "pur-2": "Troubleshoot FO"})

	rec = serve(engine, "GET", "/visits", nil, "")
	mustStatus(t, rec, 200)
	var page struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(mustSuccess(t, rec).Data, &page); err != nil || len(page.Items) != 1 {
		t.Fatalf("list shape wrong: %v: %q", err, mustSuccess(t, rec).Data)
	}
	assertPurposes(t, page.Items[0], map[string]string{"pur-1": "Maintenance Genset", "pur-2": "Troubleshoot FO"})
}

func assertPurposes(t *testing.T, detail map[string]any, want map[string]string) {
	t.Helper()
	raw, ok := detail["purposes"]
	if !ok {
		t.Fatalf("purposes key missing in %v", detail)
	}
	items, ok := raw.([]any)
	if !ok {
		t.Fatalf("purposes is not an array, got %T (%v)", raw, raw)
	}
	if len(items) != len(want) {
		t.Fatalf("purposes = %d items, want %d: %v", len(items), len(want), raw)
	}
	for _, item := range items {
		obj, ok := item.(map[string]any)
		if !ok {
			t.Fatalf("purpose item is not an object: %v", item)
		}
		id, _ := obj["id"].(string)
		name, _ := obj["name"].(string)
		wantName, ok := want[id]
		if !ok {
			t.Fatalf("unexpected purpose id %q in %v", id, raw)
		}
		if name != wantName {
			t.Fatalf("purpose %q name = %q, want %q", id, name, wantName)
		}
	}
}
