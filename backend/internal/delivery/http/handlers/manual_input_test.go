package handlers_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"thc-vms/backend/internal/domain"
)

// visitBodyJSON builds a minimal valid POST /visits body. purposeIDs may be
// empty (the purpose_note-only case) and extra is spliced into the first
// visitor so each case can vary one member at a time.
func visitBodyJSON(locationID string, purposeIDs []string, purposeNote string, extra string) string {
	purposes := "[]"
	if len(purposeIDs) > 0 {
		quoted := make([]string, 0, len(purposeIDs))
		for _, p := range purposeIDs {
			quoted = append(quoted, `"`+p+`"`)
		}
		purposes = "[" + strings.Join(quoted, ",") + "]"
	}
	return fmt.Sprintf(`{
		"location_id": %q,
		"purpose_ids": %s,
		"purpose_note": %q,
		"start_date": "2026-10-01T09:00:00Z",
		"end_date": "2026-10-01T17:00:00Z",
		"is_nda_accepted": true,
		"notes": "splicing FO",
		"assignment_letter_url": "http://localhost:9000/thc-vms-bucket/assignment_letters/visit-1/spk.pdf",
		"visitors": [
			{"name":"Andi","id_number":"3578010100000001","phone":"0811"%s},
			{"name":"Budi","id_number":"3578010200000002","phone":"0812"}
		]
	}`, locationID, purposes, purposeNote, extra)
}

// manualCompanyVisit is the created row the fake returns for the manual-input
// cases: one technician whose company was typed by hand (no catalogue link) and
// one internal staffer with no company at all.
func manualCompanyVisit() domain.VisitRequest {
	v := cannedVisit()
	v.PurposeNote = nil
	v.VendorID = ""
	v.VendorName = ""
	v.Visitors = []domain.Visitor{
		{
			ID: "visitor-1", VisitRequestID: "visit-1",
			Name: "Andi", IDNumber: "3578010100000001", Phone: "0811",
			VendorNameOverride: strPtr("PT Subkon Mandiri"), VendorName: "PT Subkon Mandiri",
		},
		{
			ID: "visitor-2", VisitRequestID: "visit-1",
			Name: "Budi", IDNumber: "3578010200000002", Phone: "0812",
		},
	}
	return v
}

// mustErrorCode asserts the envelope carries the wanted status and error code
// and returns the human message so tests can pin the Indonesian wording.
func mustErrorCode(t *testing.T, rec *httptest.ResponseRecorder, status int, code string) string {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status = %d, want %d: %q", rec.Code, status, rec.Body.String())
	}
	env := decodeEnvelope(t, rec)
	if env.Error == nil {
		t.Fatalf("error body missing: %q", rec.Body.String())
	}
	if env.Error.Code != code {
		t.Fatalf("error code = %q, want %q: %q", env.Error.Code, code, env.Error.Message)
	}
	if env.Error.Message == "" {
		t.Fatal("error message must not be empty")
	}
	return env.Error.Message
}

// TestCreateVisit_PurposeNoteOnlyAccepted pins the wire contract of the
// free-typed purpose (migration 000005): a visit with no catalogue purpose but
// a typed purpose_note is a normal 201, the note travels to the usecase
// verbatim, and the response carries it while purposes stays an empty array.
func TestCreateVisit_PurposeNoteOnlyAccepted(t *testing.T) {
	note := "Perbaikan scrambling servis di luar katalog"
	created := manualCompanyVisit()
	created.PurposeNote = &note
	svc := &fakeVisitService{created: created}
	engine := newVisitEngine(svc, domain.RoleSuperAdmin, "")

	body := visitBodyJSON("11111111-1111-1111-1111-111111111111", nil, note, "")
	rec := serveJSON(engine, "POST", "/visits", body)
	mustStatus(t, rec, http.StatusCreated)

	// The handler bound the note and did not invent a catalogue purpose.
	if svc.lastCreateIn.PurposeNote != note {
		t.Errorf("PurposeNote = %q, want the typed note %q", svc.lastCreateIn.PurposeNote, note)
	}
	if len(svc.lastCreateIn.PurposeIDs) != 0 {
		t.Errorf("PurposeIDs = %v, want none without a catalogue choice", svc.lastCreateIn.PurposeIDs)
	}

	data := decodeData[map[string]any](t, mustSuccess(t, rec))
	if got := data["purpose_note"]; got != note {
		t.Errorf("response purpose_note = %v, want %q", got, note)
	}
	purposes, ok := data["purposes"].([]any)
	if !ok || len(purposes) != 0 {
		t.Errorf("purposes = %v, want an empty array (key must stay present)", data["purposes"])
	}
}

// TestCreateVisit_PurposeNoteAlongsideCataloguePurpose pins that the two
// purpose sources are additive, not exclusive: a body carrying both keeps the
// catalogue ids and the free note.
func TestCreateVisit_PurposeNoteAlongsideCataloguePurpose(t *testing.T) {
	note := "Tambahan: ganti rectifier"
	purposeID := "22222222-2222-2222-2222-222222222222"
	created := manualCompanyVisit()
	created.PurposeNote = &note
	created.Purposes = []domain.Purpose{{ID: domain.UUID(purposeID), Name: "Splicing FO", IsActive: true}}
	svc := &fakeVisitService{created: created}
	engine := newVisitEngine(svc, domain.RoleSuperAdmin, "")

	rec := serveJSON(engine, "POST", "/visits", visitBodyJSON(
		"11111111-1111-1111-1111-111111111111", []string{purposeID}, note, ""))
	mustStatus(t, rec, http.StatusCreated)

	if svc.lastCreateIn.PurposeNote != note {
		t.Errorf("PurposeNote = %q, want %q", svc.lastCreateIn.PurposeNote, note)
	}
	if len(svc.lastCreateIn.PurposeIDs) != 1 || string(svc.lastCreateIn.PurposeIDs[0]) != purposeID {
		t.Errorf("PurposeIDs = %v, want the catalogue choice preserved", svc.lastCreateIn.PurposeIDs)
	}

	data := decodeData[map[string]any](t, mustSuccess(t, rec))
	purposes, ok := data["purposes"].([]any)
	if !ok || len(purposes) != 1 {
		t.Errorf("purposes = %v, want the one catalogue purpose echoed", data["purposes"])
	} else if purpose, ok := purposes[0].(map[string]any); !ok {
		t.Errorf("purposes[0] is not an object: %#v", purposes[0])
	} else if purpose["name"] != "Splicing FO" {
		t.Errorf("purposes[0].name = %v, want the catalogue name (bukan shell ID-only)", purpose["name"])
	}
}

// TestCreateVisit_RequiresAPurposeOrNote pins the minimal-purpose rule at the
// HTTP edge: with neither a catalogue purpose nor a typed note the request is
// refused before the usecase runs, so nothing is ever persisted.
func TestCreateVisit_RequiresAPurposeOrNote(t *testing.T) {
	cases := []struct {
		name       string
		body       string
		wantSubstr string
	}{
		{
			name:       "no purpose at all",
			body:       visitBodyJSON("11111111-1111-1111-1111-111111111111", nil, "", ""),
			wantSubstr: "Minimal satu tujuan",
		},
		{
			name:       "whitespace-only note",
			body:       visitBodyJSON("11111111-1111-1111-1111-111111111111", nil, "   ", ""),
			wantSubstr: "Minimal satu tujuan",
		},
		{
			name:       "empty purpose_ids array",
			body:       visitBodyJSON("11111111-1111-1111-1111-111111111111", []string{}, "", ""),
			wantSubstr: "Minimal satu tujuan",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc := &fakeVisitService{}
			engine := newVisitEngine(svc, domain.RoleSuperAdmin, "")

			rec := serveJSON(engine, "POST", "/visits", tc.body)
			msg := mustErrorCode(t, rec, http.StatusBadRequest, "VALIDATION_ERROR")
			if !strings.Contains(msg, tc.wantSubstr) {
				t.Errorf("message = %q, want it to contain %q", msg, tc.wantSubstr)
			}
			if svc.lastCreateIn.LocationID != "" {
				t.Error("a refused body must never reach the usecase")
			}
		})
	}
}

// TestCreateVisit_ManualVendorNameLength pins the 120-rune cap on the typed
// company at the HTTP edge, with the Indonesian wording that names the bound.
func TestCreateVisit_ManualVendorNameLength(t *testing.T) {
	cases := []struct {
		name    string
		company string
		wantErr bool
	}{
		{name: "120 runes accepted", company: strings.Repeat("A", 120)},
		{name: "padded 120 runes accepted", company: "  " + strings.Repeat("A", 120) + "  "},
		{name: "121 runes refused", company: strings.Repeat("A", 121), wantErr: true},
		{name: "padded 121 runes refused", company: " " + strings.Repeat("A", 121) + " ", wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc := &fakeVisitService{created: manualCompanyVisit()}
			engine := newVisitEngine(svc, domain.RoleSuperAdmin, "")
			extra := `,"vendor_name":` + mustJSON(t, tc.company)

			rec := serveJSON(engine, "POST", "/visits", visitBodyJSON(
				"11111111-1111-1111-1111-111111111111",
				[]string{"22222222-2222-2222-2222-222222222222"}, "note", extra))

			if tc.wantErr {
				msg := mustErrorCode(t, rec, http.StatusBadRequest, "VALIDATION_ERROR")
				if !strings.Contains(msg, "120 karakter") {
					t.Errorf("message = %q, want it to name the 120-rune bound", msg)
				}
				if svc.lastCreateIn.LocationID != "" {
					t.Error("an overlong company must never reach the usecase")
				}
				return
			}
			mustStatus(t, rec, http.StatusCreated)
			if svc.lastCreateIn.Visitors[0].VendorName == nil ||
				*svc.lastCreateIn.Visitors[0].VendorName != tc.company {
				t.Errorf("bound VendorName = %v, want the typed text verbatim", svc.lastCreateIn.Visitors[0].VendorName)
			}
		})
	}
}

// TestCreateVisit_PurposeNoteLength pins the 200-rune cap on the free note.
func TestCreateVisit_PurposeNoteLength(t *testing.T) {
	svc := &fakeVisitService{created: manualCompanyVisit()}
	engine := newVisitEngine(svc, domain.RoleSuperAdmin, "")

	rec := serveJSON(engine, "POST", "/visits", visitBodyJSON(
		"11111111-1111-1111-1111-111111111111", nil, strings.Repeat("C", 201), ""))
	msg := mustErrorCode(t, rec, http.StatusBadRequest, "VALIDATION_ERROR")
	if !strings.Contains(msg, "200 karakter") {
		t.Errorf("message = %q, want it to name the 200-rune bound", msg)
	}
	if svc.lastCreateIn.LocationID != "" {
		t.Error("an overlong note must never reach the usecase")
	}

	// 200 exactly is inside the limit.
	ok := &fakeVisitService{created: manualCompanyVisit()}
	engine = newVisitEngine(ok, domain.RoleSuperAdmin, "")
	mustStatus(t, serveJSON(engine, "POST", "/visits", visitBodyJSON(
		"11111111-1111-1111-1111-111111111111", nil, strings.Repeat("C", 200), "")),
		http.StatusCreated)
}

// TestCreateVisit_ManualVendorNameEchoed pins the response projection: a
// technician with a typed company renders vendor_name, an internal staffer with
// no company at all omits the key, and neither case adds vendor_id.
func TestCreateVisit_ManualVendorNameEchoed(t *testing.T) {
	svc := &fakeVisitService{created: manualCompanyVisit()}
	engine := newVisitEngine(svc, domain.RoleSuperAdmin, "")

	rec := serveJSON(engine, "POST", "/visits", visitBodyJSON(
		"11111111-1111-1111-1111-111111111111", []string{"22222222-2222-2222-2222-222222222222"},
		"note", `,"vendor_name":"PT Subkon Mandiri"`))
	mustStatus(t, rec, http.StatusCreated)

	data := decodeData[map[string]any](t, mustSuccess(t, rec))
	visitors, ok := data["visitors"].([]any)
	if !ok || len(visitors) != 2 {
		t.Fatalf("visitors = %v, want the two rostered technicians", data["visitors"])
	}

	first, ok := visitors[0].(map[string]any)
	if !ok {
		t.Fatalf("visitors[0] is not an object: %#v", visitors[0])
	}
	if first["vendor_name"] != "PT Subkon Mandiri" {
		t.Errorf("visitors[0].vendor_name = %v, want the typed company", first["vendor_name"])
	}
	if _, has := first["vendor_id"]; has {
		t.Error("visitors[0].vendor_id must be absent when only a manual name was sent")
	}

	second, ok := visitors[1].(map[string]any)
	if !ok {
		t.Fatalf("visitors[1] is not an object: %#v", visitors[1])
	}
	if _, has := second["vendor_name"]; has {
		t.Error("visitors[1].vendor_name must be omitted for a technician with no company")
	}
}

// TestCreateVisit_ManualInputNeverLeaksIntoCatalogue guards the separation the
// whole feature rests on: the manual text travels as request data and is
// rendered as a display name, but no handler response may present it as a
// catalogue row or add a catalogue-only key.
func TestCreateVisit_ManualInputNeverLeaksIntoCatalogue(t *testing.T) {
	note := "Maintenance di luar katalog"
	created := manualCompanyVisit()
	created.PurposeNote = &note
	svc := &fakeVisitService{created: created}
	engine := newVisitEngine(svc, domain.RoleSuperAdmin, "")

	rec := serveJSON(engine, "POST", "/visits", visitBodyJSON(
		"11111111-1111-1111-1111-111111111111", nil, note, `,"vendor_name":"PT Subkon Mandiri"`))
	mustStatus(t, rec, http.StatusCreated)

	raw := rec.Body.Bytes()
	// The typed company appears exactly once, as the resolved display name on
	// the technician that carries it - never as a top-level catalogue member.
	var probe map[string]any
	if err := json.Unmarshal(raw, &probe); err != nil {
		t.Fatalf("response is not valid JSON: %v", err)
	}
	data, ok := probe["data"].(map[string]any)
	if !ok {
		t.Fatalf("envelope has no data object: %q", raw)
	}
	// The visit-level vendor_name key always exists (no omitempty on
	// VisitDetail), but a manual PER-TECHNICIAN company must not surface there:
	// the visit itself names no company, so it renders empty.
	if got := data["vendor_name"]; got != "" {
		t.Errorf("visit-level vendor_name = %v, want empty for a manual per-technician company", got)
	}
	if _, has := data["vendor_id"]; has {
		t.Error("visit-level vendor_id must not be invented from a manual company")
	}
	if strings.Count(string(raw), "PT Subkon Mandiri") != 1 {
		t.Errorf("typed company must appear once, got %d: %q",
			strings.Count(string(raw), "PT Subkon Mandiri"), raw)
	}
	// Purpose shells stay an array of catalogue rows only.
	if purposes, ok := data["purposes"].([]any); !ok || len(purposes) != 0 {
		t.Errorf("purposes = %v, want empty (no catalogue link was sent)", data["purposes"])
	}
}

// mustJSON encodes a Go string as a JSON literal.
func mustJSON(t *testing.T, s string) string {
	t.Helper()
	b, err := json.Marshal(s)
	if err != nil {
		t.Fatalf("encoding %q: %v", s, err)
	}
	return string(b)
}
