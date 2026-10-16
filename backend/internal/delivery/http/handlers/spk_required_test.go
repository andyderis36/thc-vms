package handlers_test

import (
	"net/http"
	"strings"
	"testing"

	"thc-vms/backend/internal/domain"
)

// TestCreateVisit_RequiresAssignmentLetterURL pins the HTTP edge of the
// CREATE-only SPK rule: POST /visits without assignment_letter_url is a 400
// VALIDATION_ERROR with the FE-aligned wording, before the usecase runs.
func TestCreateVisit_RequiresAssignmentLetterURL(t *testing.T) {
	cases := map[string]string{
		"missing SPK": `{
			"location_id": "11111111-1111-1111-1111-111111111111",
			"purpose_ids": ["22222222-2222-2222-2222-222222222222"],
			"start_date": "2026-10-01T09:00:00Z",
			"end_date": "2026-10-01T17:00:00Z",
			"is_nda_accepted": true,
			"visitors": [{"name": "Andi", "id_number": "ID123", "phone": "0811"}]
		}`,
		"empty SPK": `{
			"location_id": "11111111-1111-1111-1111-111111111111",
			"purpose_ids": ["22222222-2222-2222-2222-222222222222"],
			"start_date": "2026-10-01T09:00:00Z",
			"end_date": "2026-10-01T17:00:00Z",
			"is_nda_accepted": true,
			"assignment_letter_url": "",
			"visitors": [{"name": "Andi", "id_number": "ID123", "phone": "0811"}]
		}`,
		"whitespace SPK": `{
			"location_id": "11111111-1111-1111-1111-111111111111",
			"purpose_ids": ["22222222-2222-2222-2222-222222222222"],
			"start_date": "2026-10-01T09:00:00Z",
			"end_date": "2026-10-01T17:00:00Z",
			"is_nda_accepted": true,
			"assignment_letter_url": "   ",
			"visitors": [{"name": "Andi", "id_number": "ID123", "phone": "0811"}]
		}`,
	}
	for name, payload := range cases {
		t.Run(name, func(t *testing.T) {
			svc := &fakeVisitService{}
			engine := newVisitEngine(svc, domain.RoleVendor, "")

			rec := serveJSON(engine, "POST", "/visits", payload)
			mustStatus(t, rec, http.StatusBadRequest)
			env := decodeEnvelope(t, rec)
			if env.Error == nil || env.Error.Code != "VALIDATION_ERROR" {
				t.Fatalf("must be 400 VALIDATION_ERROR, got %q", rec.Body.String())
			}
			if !strings.Contains(env.Error.Message, "Surat Tugas / SPK wajib diunggah.") {
				t.Fatalf("message = %q, want the FE-aligned SPK wording", env.Error.Message)
			}
			if svc.lastCreateIn.LocationID != "" {
				t.Fatal("a rejected body must never reach the usecase")
			}
		})
	}
}
