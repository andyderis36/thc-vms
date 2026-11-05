package handlers

import (
	"encoding/json"
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
)

// TestToVisitorDTOCarriesEmail pins the VisitorItem wire shape: a stored
// member address renders as email, an absent one is omitted.
func TestToVisitorDTOCarriesEmail(t *testing.T) {
	email := "teknisi@example.co.id"
	dto := toVisitorDTO(domain.Visitor{Name: "Andi", IDNumber: "ID123", Phone: "0811", Email: &email})
	if dto.Email == nil || *dto.Email != email {
		t.Fatalf("Email = %v, want %q", dto.Email, email)
	}
	raw, err := json.Marshal(dto)
	if err != nil {
		t.Fatalf("marshal visitorDTO: %v", err)
	}
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil {
		t.Fatalf("unmarshal visitorDTO: %v", err)
	}
	if obj["email"] != email {
		t.Fatalf("wire email = %v, want %q", obj["email"], email)
	}

	bare := toVisitorDTO(domain.Visitor{Name: "Andi", IDNumber: "ID123", Phone: "0811"})
	raw, err = json.Marshal(bare)
	if err != nil {
		t.Fatalf("marshal visitorDTO: %v", err)
	}
	obj = map[string]any{}
	if err := json.Unmarshal(raw, &obj); err != nil {
		t.Fatalf("unmarshal visitorDTO: %v", err)
	}
	if _, ok := obj["email"]; ok {
		t.Fatalf("absent email must be omitted from the wire, got %v", obj["email"])
	}
}

// TestToCreateInputCarriesEmail pins the POST /visits mapping: the member
// address travels verbatim into the usecase input (trimming happens there).
func TestToCreateInputCarriesEmail(t *testing.T) {
	start := time.Date(2026, 10, 25, 9, 0, 0, 0, time.UTC)
	payload, err := json.Marshal(map[string]any{
		"location_id":           "868430ab-ed33-552b-8619-0b7376537262",
		"purpose_ids":           []string{"f97105bd-08d4-56c1-9a49-494bfe5f5482"},
		"assignment_letter_url": "https://cdn.example.internal/assignment_letters/v/spk.pdf",
		"visitors": []map[string]any{{
			"name":      "Teknisi Uji",
			"id_number": "6171010101010001",
			"phone":     "081234567890",
			"email":     "teknisi@example.co.id",
		}},
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	var body createVisitBody
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	in := toCreateInput(body, start, start.Add(time.Hour))
	if in.Visitors[0].Email == nil || *in.Visitors[0].Email != "teknisi@example.co.id" {
		t.Fatalf("input email = %v, want %q", in.Visitors[0].Email, "teknisi@example.co.id")
	}
}
