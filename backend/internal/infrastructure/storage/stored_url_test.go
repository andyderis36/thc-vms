package storage

import (
	"errors"
	"strings"
	"testing"

	"thc-vms/backend/internal/domain"
)

const (
	testPublicBase = "http://localhost:9000/thc-vms-bucket"
	testBucket     = "thc-vms-bucket"
)

// Given a stored absolute URL that exposes our bucket name as a path segment,
// when it is reversed, then the exact "<directory>/<owner>/<file>" key comes
// back, including the pre-create "pending" owner segment.
//
// The host is a deployment detail: the cases below deliberately mix the local
// MinIO host, a LAN IP, a Cloudflare quick-tunnel hostname and a CDN hostname,
// because the bucket name in the path — not the origin — is what binds a
// stored URL to our bucket.
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
		{"profile photo", testPublicBase + "/profile_photos/user-1/avatar.jpg", "profile_photos/user-1/avatar.jpg"},
		{"work photo", testPublicBase + "/work_photos/visit-1/before.jpg", "work_photos/visit-1/before.jpg"},
		{"query stripped", testPublicBase + "/id_cards/visitor-9/ktp.jpg?X-Amz-Expires=900", "id_cards/visitor-9/ktp.jpg"},
		{"lan ip host", "http://10.11.6.110/s3/thc-vms-bucket/assignment_letters/visit-1/spk.pdf", "assignment_letters/visit-1/spk.pdf"},
		{"cloudflare tunnel host", "https://random-word-4711.trycloudflare.com/s3/thc-vms-bucket/id_cards/visitor-9/ktp.jpg", "id_cards/visitor-9/ktp.jpg"},
		{"other host without s3 prefix", "https://cdn.example.com/thc-vms-bucket/checkin_photos/visit-1/gate.png", "checkin_photos/visit-1/gate.png"},
		{"percent encoded file name", "https://10.11.6.110/s3/thc-vms-bucket/assignment_letters/visit-1/Surat%20Izin%20Kerja.pdf", "assignment_letters/visit-1/Surat Izin Kerja.pdf"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := objectKeyFromStoredURL(testPublicBase, testBucket, tc.raw)
			if err != nil {
				t.Fatalf("objectKeyFromStoredURL(%q) = %v, want nil", tc.raw, err)
			}
			if got != tc.want {
				t.Fatalf("objectKeyFromStoredURL(%q) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}

// Given a URL that does not point at one of our own objects, when it is
// reversed, then it is refused with a validation failure so the caller blanks
// it instead of presigning or echoing a third-party address.
//
// A foreign ORIGIN alone no longer refuses a URL: what refuses it is a path
// that does not expose our bucket name as a full segment, a shape that is not
// an absolute http(s) URL, a base that hides the bucket, or a key that breaks
// the "<directory>/<owner>/<file>" layout.
func TestObjectKeyFromStoredURL_RejectsForeignAndHostileURLs(t *testing.T) {
	cases := []struct {
		name   string
		base   string
		bucket string
		raw    string
	}{
		{"empty url", testPublicBase, testBucket, ""},
		{"blank url", testPublicBase, testBucket, "   "},
		{"foreign origin", testPublicBase, testBucket, "https://evil.example.com/spk.pdf"},
		{"foreign https bucket lookalike", testPublicBase, testBucket, "http://localhost:9000/other-bucket/assignment_letters/visit-1/spk.pdf"},
		{"prefix sibling bucket", testPublicBase, testBucket, testPublicBase + "-evil/assignment_letters/visit-1/spk.pdf"},
		{"bare base without key", testPublicBase, testBucket, testPublicBase},
		{"directory only", testPublicBase, testBucket, testPublicBase + "/assignment_letters"},
		{"unknown directory", testPublicBase, testBucket, testPublicBase + "/avatars/visit-1/x.jpg"},
		{"path traversal", testPublicBase, testBucket, testPublicBase + "/assignment_letters/../secret/key"},
		{"encoded traversal", testPublicBase, testBucket, testPublicBase + "/assignment_letters/%2e%2e/secret"},
		{"backslash segment", testPublicBase, testBucket, testPublicBase + `/assignment_letters/visit-1\..\spk.pdf`},
		{"javascript scheme", testPublicBase, testBucket, "javascript:alert(1)"},
		{"unconfigured base", "", testBucket, testPublicBase + "/assignment_letters/visit-1/spk.pdf"},
		{"base without bucket segment", "http://localhost:9000/s3", testBucket, testPublicBase + "/assignment_letters/visit-1/spk.pdf"},
		{"file scheme", testPublicBase, testBucket, "file:///thc-vms-bucket/assignment_letters/visit-1/spk.pdf"},
		{"missing host", testPublicBase, testBucket, "http:///thc-vms-bucket/assignment_letters/visit-1/spk.pdf"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got, err := objectKeyFromStoredURL(tc.base, tc.bucket, tc.raw); err == nil {
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
	got, err := objectKeyFromStoredURL(testPublicBase+"/", testBucket, raw)
	if err != nil {
		t.Fatalf("objectKeyFromStoredURL with trailing-slash base = %v, want nil", err)
	}
	if !strings.HasPrefix(got, "id_cards/") {
		t.Fatalf("key = %q, want id_cards/ prefix", got)
	}
}
