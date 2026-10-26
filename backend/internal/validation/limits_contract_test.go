package validation

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// openAPIPath is repo-relative from this package directory:
// backend/internal/validation -> ../../../docs/4. openapi.yaml.
var openAPIPath = filepath.Join("..", "..", "..", "docs", "4. openapi.yaml")

// xLimitLine matches one indented key/value pair inside the x-limits block.
var xLimitLine = regexp.MustCompile(`^  ([A-Za-z0-9_]+):[ \t]*(.+?)[ \t]*$`)

// TestLimitsMatchOpenAPI pins every Go constant to the x-limits block, the
// canonical SSOT shared with frontend/src/lib/limits.ts. Parsing is a plain
// line regex on purpose: a YAML dependency for six flat keys would be
// over-engineering, and the block's shape is fixed by the contract.
func TestLimitsMatchOpenAPI(t *testing.T) {
	raw, err := os.ReadFile(openAPIPath)
	if err != nil {
		t.Fatalf("read OpenAPI SSOT %s: %v", openAPIPath, err)
	}
	limits := parseXLimits(t, string(raw))
	if len(limits) == 0 {
		t.Fatalf("x-limits block not found in %s (owned by another agent; do not create it here)", openAPIPath)
	}

	cases := []struct {
		key  string
		want string
	}{
		{"name_max_length", strconv.Itoa(NameMaxLength)},
		{"id_number_pattern", IDNumberPattern},
		{"id_number_max_length", strconv.Itoa(IDNumberMaxLength)},
		{"phone_pattern", PhonePattern},
		{"phone_max_length", strconv.Itoa(PhoneMaxLength)},
		{"password_min_length", strconv.Itoa(PasswordMinLength)},
		{"password_max_bytes", strconv.Itoa(PasswordMaxBytes)},
		{"email_max_length", strconv.Itoa(EmailMaxLength)},
		{"text_max_length", strconv.Itoa(TextMaxLength)},
		{"reject_reason_min_length", strconv.Itoa(RejectReasonMinLength)},
		{"facility_name_max_length", strconv.Itoa(FacilityNameMaxLength)},
		{"facility_address_max_length", strconv.Itoa(FacilityAddressMaxLength)},
		{"facility_city_max_length", strconv.Itoa(FacilityCityMaxLength)},
		{"visit_id_input_max_length", strconv.Itoa(VisitIDInputMaxLength)},
		{"badge_code_max_length", strconv.Itoa(BadgeCodeMaxLength)},
		{"checkin_notes_max_length", strconv.Itoa(CheckinNotesMaxLength)},
		{"search_query_max_length", strconv.Itoa(SearchQueryMaxLength)},
		{"vendor_name_max_length", strconv.Itoa(VendorNameMaxLength)},
		{"jabatan_max_length", strconv.Itoa(JabatanMaxLength)},
		{"purpose_note_max_length", strconv.Itoa(PurposeNoteMaxLength)},
		{"nik_length", strconv.Itoa(NIKLength)},
		{"technicians_max", strconv.Itoa(TechniciansMax)},
		{"json_body_max_bytes", strconv.Itoa(JSONBodyMaxBytes)},
		{"upload_stored_max_bytes", strconv.Itoa(UploadStoredMaxBytes)},
		{"upload_ingest_max_bytes", strconv.Itoa(UploadIngestMaxBytes)},
	}
	for _, tc := range cases {
		t.Run(tc.key, func(t *testing.T) {
			got, ok := limits[tc.key]
			if !ok {
				t.Fatalf("x-limits is missing %q", tc.key)
			}
			if got != tc.want {
				t.Fatalf("x-limits %s = %q, Go constant = %q", tc.key, got, tc.want)
			}
		})
	}
}

// parseXLimits extracts "key: value" pairs from the top-level x-limits block.
// It stops at the first line that is not an indented key/value pair, so the
// following top-level "servers:" key terminates the scan. Surrounding double
// quotes around pattern values are stripped before comparison.
func parseXLimits(t *testing.T, text string) map[string]string {
	t.Helper()
	parsed := make(map[string]string)
	inBlock := false
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimRight(line, "\r")
		if !inBlock {
			if line == "x-limits:" {
				inBlock = true
			}
			continue
		}
		match := xLimitLine.FindStringSubmatch(line)
		if match == nil {
			break
		}
		value := strings.TrimSpace(match[2])
		if len(value) >= 2 && value[0] == '"' && value[len(value)-1] == '"' {
			value = value[1 : len(value)-1]
		}
		parsed[match[1]] = value
	}
	return parsed
}
