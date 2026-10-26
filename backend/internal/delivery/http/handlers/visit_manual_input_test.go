package handlers_test

// HTTP seam of the manual-company + free-purpose flow (migration 000005).
// The usecase suite (internal/usecase/visit/manual_input_test.go) owns the
// trimming, catalogue precedence and persistence rules; this file pins what
// the wire must do: map both body members onto the usecase input, render the
// resolved roster back on the created detail, and refuse the documented 400
// matrix BEFORE the usecase is ever called.

import (
	"net/http"
	"strings"
	"testing"

	"thc-vms/backend/internal/domain"
)

const (
	manualLocUUID  = "11111111-1111-1111-1111-111111111111"
	manualCatUUID  = "22222222-2222-2222-2222-222222222222"
	manualVendorID = "33333333-3333-3333-3333-333333333333"

	// manualCompany / manualPurpose are the two free-typed values used across
	// the suite: a company outside the vendor catalogue and a purpose outside
	// the purpose catalogue.
	manualCompany = "PT Subkon Mandiri"
	manualPurpose = "Perbaikan darurat"
)

// manualVisitPayload builds a POST /visits body from the purpose field and the
// visitor tail so each case below differs only in what it exercises.
func manualVisitPayload(purposeField, visitorTail string) string {
	return `{
		"location_id": "` + manualLocUUID + `",
		` + purposeField + `
		"start_date": "2026-10-01T09:00:00Z",
		"end_date": "2026-10-01T17:00:00Z",
		"is_nda_accepted": true,
		"assignment_letter_url": "http://localhost:9000/thc-vms-bucket/assignment_letters/visit-1/spk.pdf",
		"visitors": [{"name": "Andi", "id_number": "ID12345678", "phone": "081234567890"` + visitorTail + `}]
	}`
}

// TestCreateVisit_AcceptsManualCompanyAndPurposeNote proves a visit can be
// filed entirely outside both catalogues: a typed company on the technician
// and a free-typed purpose instead of a purpose_id. Both must reach the usecase
// and come back on the 201 detail, with purposes rendering [] (never null) and
// purpose_note rendering the typed text.
func TestCreateVisit_AcceptsManualCompanyAndPurposeNote(t *testing.T) {
	created := cannedVisit()
	created.PurposeNote = strPtr(manualPurpose)
	created.Purposes = nil
	created.Visitors = []domain.Visitor{{
		ID: "visitor-1", VisitRequestID: "visit-1",
		Name: "Andi", IDNumber: "ID123", Phone: "0811",
		VendorName:         manualCompany,
		VendorNameOverride: strPtr(manualCompany),
	}}
	svc := &fakeVisitService{created: created}
	engine := newVisitEngine(svc, domain.RoleVendor, "")

	payload := manualVisitPayload(`"purpose_note": "`+manualPurpose+`",`,
		`, "vendor_name": "`+manualCompany+`"`)
	rec := serveJSON(engine, "POST", "/visits", payload)
	mustStatus(t, rec, http.StatusCreated)

	if len(svc.lastCreateIn.PurposeIDs) != 0 {
		t.Fatalf("purpose_ids must stay empty on a note-only visit: %+v", svc.lastCreateIn.PurposeIDs)
	}
	if svc.lastCreateIn.PurposeNote != manualPurpose {
		t.Fatalf("purpose_note not mapped onto the usecase input: %q", svc.lastCreateIn.PurposeNote)
	}
	if len(svc.lastCreateIn.Visitors) != 1 {
		t.Fatalf("roster not mapped: %+v", svc.lastCreateIn.Visitors)
	}
	if got := svc.lastCreateIn.Visitors[0].VendorName; got == nil || *got != manualCompany {
		t.Fatalf("manual vendor_name not mapped onto the usecase input: %+v", got)
	}

	detail := asObject(t, mustSuccess(t, rec).Data)
	if detail["purpose_note"] != manualPurpose {
		t.Fatalf("purpose_note must render on the created detail, got %v", detail["purpose_note"])
	}
	purposes, ok := detail["purposes"].([]any)
	if !ok || len(purposes) != 0 {
		t.Fatalf("purposes must render [] for a note-only visit, got %v", detail["purposes"])
	}
	visitors, ok := detail["visitors"].([]any)
	if !ok || len(visitors) != 1 {
		t.Fatalf("visitors echo wrong: %v", detail["visitors"])
	}
	if echo := visitors[0].(map[string]any); echo["vendor_name"] != manualCompany {
		t.Fatalf("resolved manual vendor_name must render on the roster, got %v", echo)
	}
}

// TestCreateVisit_VendorIDWinsOverManualCompany pins the catalogue precedence
// at the wire: both members may travel (the usecase owns the decision), but
// the echoed roster must carry the resolved catalogue name, never the manual
// text.
func TestCreateVisit_VendorIDWinsOverManualCompany(t *testing.T) {
	svc := &fakeVisitService{created: cannedVisit()} // roster: vendor-1 + "PT Lintas Fiber"
	engine := newVisitEngine(svc, domain.RoleVendor, "")

	payload := manualVisitPayload(`"purpose_ids": ["`+manualCatUUID+`"],`,
		`, "vendor_id": "`+manualVendorID+`", "vendor_name": "`+manualCompany+`"`)
	rec := serveJSON(engine, "POST", "/visits", payload)
	mustStatus(t, rec, http.StatusCreated)

	visitor := svc.lastCreateIn.Visitors[0]
	if visitor.VendorID == nil || string(*visitor.VendorID) != manualVendorID {
		t.Fatalf("a sent vendor_id must reach the usecase untouched: %+v", visitor.VendorID)
	}
	if visitor.VendorName == nil || *visitor.VendorName != manualCompany {
		t.Fatalf("the manual text must still reach the usecase to be discarded there: %+v", visitor.VendorName)
	}

	visitors := asObject(t, mustSuccess(t, rec).Data)["visitors"].([]any)
	echo := visitors[0].(map[string]any)
	if echo["vendor_name"] != "PT Lintas Fiber" {
		t.Fatalf("catalogue name must win the echo, got %v", echo["vendor_name"])
	}
}

// TestCreateVisit_RejectsManualInputOutOfBounds is the negative half of QA
// VISIT-09: a 121-rune company, a 201-rune purpose note and a whitespace-only
// purpose_note are all 400 VALIDATION_ERROR with an Indonesian message, and
// none of them may reach the usecase.
func TestCreateVisit_RejectsManualInputOutOfBounds(t *testing.T) {
	svc := &fakeVisitService{}
	engine := newVisitEngine(svc, domain.RoleVendor, "")

	cases := []struct {
		name    string
		payload string
		wantMsg string
	}{
		{
			name:    "company over 120 runes",
			payload: manualVisitPayload(`"purpose_ids": ["`+manualCatUUID+`"],`, `, "vendor_name": "`+strings.Repeat("a", 121)+`"`),
			wantMsg: "maksimal 120 karakter",
		},
		{
			name:    "purpose note over 200 runes",
			payload: manualVisitPayload(`"purpose_note": "`+strings.Repeat("b", 201)+`",`, ""),
			wantMsg: "maksimal 200 karakter",
		},
		{
			name:    "no purpose ids and no purpose note",
			payload: manualVisitPayload("", ""),
			wantMsg: "Minimal satu tujuan",
		},
		{
			name:    "purpose note is whitespace only",
			payload: manualVisitPayload(`"purpose_note": "   ",`, ""),
			wantMsg: "Minimal satu tujuan",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := serveJSON(engine, "POST", "/visits", tc.payload)
			mustStatus(t, rec, http.StatusBadRequest)
			env := decodeEnvelope(t, rec)
			if env.Error == nil || env.Error.Code != "VALIDATION_ERROR" {
				t.Fatalf("must be 400 VALIDATION_ERROR, got %q", rec.Body.String())
			}
			if !strings.Contains(env.Error.Message, tc.wantMsg) {
				t.Fatalf("message must mention %q, got %q", tc.wantMsg, env.Error.Message)
			}
		})
	}
	if svc.lastCreateIn.LocationID != "" {
		t.Fatalf("a rejected body must never reach the usecase: %+v", svc.lastCreateIn)
	}
}
