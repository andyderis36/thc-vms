package validation

import "testing"

// TestLimitsValues pins the canonical numbers. limits_contract_test.go proves
// they still match docs/4. openapi.yaml; this test fails fast, without the
// docs checkout, when someone edits a literal by accident.
func TestLimitsValues(t *testing.T) {
	cases := []struct {
		name string
		got  int
		want int
	}{
		{"NameMaxLength", NameMaxLength, 100},
		{"IDNumberMaxLength", IDNumberMaxLength, 20},
		{"PhoneMaxLength", PhoneMaxLength, 16},
		{"PasswordMinLength", PasswordMinLength, 8},
		{"PasswordMaxBytes", PasswordMaxBytes, 72},
		{"EmailMaxLength", EmailMaxLength, 254},
		{"TextMaxLength", TextMaxLength, 1000},
		{"RejectReasonMinLength", RejectReasonMinLength, 5},
		{"FacilityNameMaxLength", FacilityNameMaxLength, 100},
		{"FacilityAddressMaxLength", FacilityAddressMaxLength, 255},
		{"FacilityCityMaxLength", FacilityCityMaxLength, 100},
		{"VisitIDInputMaxLength", VisitIDInputMaxLength, 64},
		{"BadgeCodeMaxLength", BadgeCodeMaxLength, 64},
		{"CheckinNotesMaxLength", CheckinNotesMaxLength, 500},
		{"SearchQueryMaxLength", SearchQueryMaxLength, 100},
	{"SuggestionQueryMaxLength", SuggestionQueryMaxLength, 80},
		{"VendorNameMaxLength", VendorNameMaxLength, 120},
		{"JabatanMaxLength", JabatanMaxLength, 120},
		{"PurposeNoteMaxLength", PurposeNoteMaxLength, 200},
		{"NIKLength", NIKLength, 16},
		{"TechniciansMax", TechniciansMax, 10},
		{"JSONBodyMaxBytes", JSONBodyMaxBytes, 1 << 20},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.got != tc.want {
				t.Fatalf("%s = %d, want %d", tc.name, tc.got, tc.want)
			}
		})
	}

	patterns := []struct {
		name string
		got  string
		want string
	}{
		{"IDNumberPattern", IDNumberPattern, `^[A-Za-z0-9]{8,20}$`},
		{"PhonePattern", PhonePattern, `^(?:62|0)[0-9]{9,15}$`},
	}
	for _, tc := range patterns {
		t.Run(tc.name, func(t *testing.T) {
			if tc.got != tc.want {
				t.Fatalf("%s = %q, want %q", tc.name, tc.got, tc.want)
			}
		})
	}
}
