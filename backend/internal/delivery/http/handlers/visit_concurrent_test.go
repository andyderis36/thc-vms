package handlers_test

import (
	"testing"

	"thc-vms/backend/internal/domain"
)

// TestCreateVisit_ConcurrentOverlappingVisitsBothAccepted pins R1 pada lapis
// HTTP: dua permohonan berhimpitan jadwal dari vendor yang sama sama-sama
// dijawab 201; penilaian duplikat tetap keputusan manusia pada approval.
func TestCreateVisit_ConcurrentOverlappingVisitsBothAccepted(t *testing.T) {
	svc := &fakeVisitService{}
	engine := newVisitEngine(svc, domain.RoleVendor, "")

	payload := `{
		"location_id": "11111111-1111-1111-1111-111111111111",
		"purpose_ids": ["22222222-2222-2222-2222-222222222222"],
		"start_date": "2026-10-01T09:00:00Z",
		"end_date": "2026-10-01T17:00:00Z",
		"is_nda_accepted": true,
		"assignment_letter_url": "http://localhost:9000/thc-vms-bucket/assignment_letters/visit-1/spk.pdf",
		"visitors": [{"name": "Andi", "id_number": "ID123", "phone": "0811"}]
	}`
	first := serveJSON(engine, "POST", "/visits", payload)
	mustStatus(t, first, 201)
	mustSuccess(t, first)

	second := serveJSON(engine, "POST", "/visits", payload)
	mustStatus(t, second, 201)
	mustSuccess(t, second)
}
