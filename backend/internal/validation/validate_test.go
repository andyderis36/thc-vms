package validation

import (
	"strings"
	"testing"
)

func TestNormalizePhone(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"local prefix", "081234567890", "081234567890"},
		{"country code with punctuation", "+62 812-3456-7890", "081234567890"},
		{"surrounding whitespace", "  0211234567  ", "0211234567"},
		{"letters are dropped", "0812abc3456", "08123456"},
		{"empty", "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := NormalizePhone(tc.raw); got != tc.want {
				t.Fatalf("NormalizePhone(%q) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}

func TestValidPhone(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want bool
	}{
		{"mobile number", "081234567890", true},
		{"landline number", "0211234567", true},
		{"country code form", "+62 812-3456-7890", true},
		{"letters only", "abcdefghij", false},
		{"too many digits", "0812345678901234", false},
		{"empty", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ValidPhone(tc.raw); got != tc.want {
				t.Fatalf("ValidPhone(%q) = %v, want %v", tc.raw, got, tc.want)
			}
		})
	}
}

func TestValidIDNumber(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want bool
	}{
		{"sixteen digits", "1234567890123456", true},
		{"alphanumeric SIM", "SIM1234567890", true},
		{"too short", "1234", false},
		{"contains space", "abc def", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ValidIDNumber(tc.raw); got != tc.want {
				t.Fatalf("ValidIDNumber(%q) = %v, want %v", tc.raw, got, tc.want)
			}
		})
	}
}

func TestValidPassword(t *testing.T) {
	cases := []struct {
		name    string
		pw      string
		wantErr bool
	}{
		{"seven runes", strings.Repeat("a", 7), true},
		{"eight runes", strings.Repeat("a", 8), false},
		{"seventy-two bytes", strings.Repeat("a", 72), false},
		{"seventy-three bytes", strings.Repeat("a", 73), true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidPassword(tc.pw)
			if tc.wantErr && err == nil {
				t.Fatalf("ValidPassword(%d bytes) = nil, want error", len(tc.pw))
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("ValidPassword(%d bytes) = %v, want nil", len(tc.pw), err)
			}
		})
	}
}

func TestValidEmail(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want bool
	}{
		{"minimal address", "a@b.co", true},
		{"missing at sign", "not-an-email", false},
		{"too long", strings.Repeat("a", 250) + "@b.co", false},
		{"display name form", "A <a@b.co>", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ValidEmail(tc.raw); got != tc.want {
				t.Fatalf("ValidEmail(%q) = %v, want %v", tc.raw, got, tc.want)
			}
		})
	}
}

func TestValidManualVisitID(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want bool
	}{
		{"human readable ticket", "VST-1234567890", true},
		{"uuid", "550e8400-e29b-41d4-a716-446655440000", true},
		{"too long", strings.Repeat("a", 65), false},
		{"contains space", "a b", false},
		{"empty", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ValidManualVisitID(tc.raw); got != tc.want {
				t.Fatalf("ValidManualVisitID(%q) = %v, want %v", tc.raw, got, tc.want)
			}
		})
	}
}

func TestRuneLen(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want int
	}{
		{"ascii", "abc", 3},
		{"multibyte", "éé", 2},
		{"empty", "", 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := RuneLen(tc.in); got != tc.want {
				t.Fatalf("RuneLen(%q) = %d, want %d", tc.in, got, tc.want)
			}
		})
	}
}
