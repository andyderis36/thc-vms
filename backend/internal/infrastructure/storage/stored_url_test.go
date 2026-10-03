package storage

import (
	"errors"
	"strings"
	"testing"

	"thc-vms/backend/internal/domain"
)

const testPublicBase = "http://localhost:9000/thc-vms-bucket"

// Given a stored absolute URL under our own public base, when it is reversed,
// then the exact "<directory>/<owner>/<file>" key comes back, including the
// pre-create "pending" owner segment.
func TestObjectKeyFromStoredURL_AcceptsOwnBucketKeys(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"spk letter", testPublicBase + "/assignment_letters/visit-1/spk.pdf", "assignment_letters/visit-1/spk.pdf"},
		{"pending owner", testPublicBase + "/assignment_letters/pending/spk.pdf", "assignment_letters/pending/spk.pdf"},
		{"ktp photo", testPublicBase + "/id_cards/visitor-9/ktp.jpg", "id_cards/visitor-9/ktp.jpg"},
		{"checkin photo", testPublicBase + "/checkin_photos/visit-1/gate.jpg", "checkin_photos/visit-1/gate.jpg"},
		{"query stripped", testPublicBase + "/id_cards/visitor-9/ktp.jpg?X-Amz-Expires=900", "id_cards/visitor-9/ktp.jpg"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := objectKeyFromStoredURL(testPublicBase, tc.raw)
			if err != nil {
				t.Fatalf("objectKeyFromStoredURL(%q) = %v, want nil", tc.raw, err)
			}
			if got != tc.want {
				t.Fatalf("objectKeyFromStoredURL(%q) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}

// Given a URL that is not our bucket's file address, when it is reversed,
// then it is refused with a validation failure so the caller blanks it
// instead of presigning or echoing a third-party address.
func TestObjectKeyFromStoredURL_RejectsForeignAndHostileURLs(t *testing.T) {
	cases := []struct {
		name string
		base string
		raw  string
	}{
		{"empty url", testPublicBase, ""},
		{"blank url", testPublicBase, "   "},
		{"foreign origin", testPublicBase, "https://evil.example.com/spk.pdf"},
		{"foreign https bucket lookalike", testPublicBase, "http://localhost:9000/other-bucket/assignment_letters/visit-1/spk.pdf"},
		{"prefix sibling bucket", testPublicBase, testPublicBase + "-evil/assignment_letters/visit-1/spk.pdf"},
		{"bare base without key", testPublicBase, testPublicBase},
		{"directory only", testPublicBase, testPublicBase + "/assignment_letters"},
		{"unknown directory", testPublicBase, testPublicBase + "/avatars/visit-1/x.jpg"},
		{"path traversal", testPublicBase, testPublicBase + "/assignment_letters/../secret/key"},
		{"encoded traversal", testPublicBase, testPublicBase + "/assignment_letters/%2e%2e/secret"},
		{"backslash segment", testPublicBase, testPublicBase + `/assignment_letters/visit-1\..\spk.pdf`},
		{"javascript scheme", testPublicBase, "javascript:alert(1)"},
		{"unconfigured base", "", testPublicBase + "/assignment_letters/visit-1/spk.pdf"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got, err := objectKeyFromStoredURL(tc.base, tc.raw); err == nil {
				t.Fatalf("objectKeyFromStoredURL(%q) = %q, want validation failure", tc.raw, got)
			} else if !errors.Is(err, domain.ErrValidation) {
				t.Fatalf("objectKeyFromStoredURL(%q) = %v, want validation failure", tc.raw, err)
			}
		})
	}
}

// Given a base URL with a trailing slash, when a stored URL is reversed, then
// the slash is normalised and the key still resolves.
func TestObjectKeyFromStoredURL_NormalisesTrailingSlashBase(t *testing.T) {
	raw := testPublicBase + "/id_cards/visitor-1/ktp.jpg"
	got, err := objectKeyFromStoredURL(testPublicBase+"/", raw)
	if err != nil {
		t.Fatalf("objectKeyFromStoredURL with trailing-slash base = %v, want nil", err)
	}
	if !strings.HasPrefix(got, "id_cards/") {
		t.Fatalf("key = %q, want id_cards/ prefix", got)
	}
}
