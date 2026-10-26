package handlers

import (
	"encoding/json"
	"testing"
	"time"
)

// TestToCreateInputStoresCanonicalPhone pins the write-path invariant: the
// phone column keeps digits only with a leading 0, so a formatted or
// letter-contaminated payload cannot persist as typed.
func TestToCreateInputStoresCanonicalPhone(t *testing.T) {
	start := time.Date(2026, 10, 25, 9, 0, 0, 0, time.UTC)
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"country code and separators", "+62 812-3456-7890", "081234567890"},
		{"stray letters", "0812abc45678", "081245678"},
		{"already canonical", "081234567890", "081234567890"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			payload, err := json.Marshal(map[string]any{
				"location_id":           "868430ab-ed33-552b-8619-0b7376537262",
				"purpose_ids":           []string{"f97105bd-08d4-56c1-9a49-494bfe5f5482"},
				"assignment_letter_url": "https://cdn.example.internal/assignment_letters/v/spk.pdf",
				"visitors": []map[string]any{{
					"name":      "Teknisi Uji",
					"id_number": "6171010101010001",
					"phone":     tc.raw,
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
			if got := in.Visitors[0].Phone; got != tc.want {
				t.Fatalf("stored phone = %q, want %q", got, tc.want)
			}
		})
	}
}
