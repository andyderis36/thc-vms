package avatarpath_test

import (
	"regexp"
	"strings"
	"testing"

	"thc-vms/backend/internal/avatarpath"
	"thc-vms/backend/internal/domain"
)

const (
	testUserID = domain.UUID("11111111-1111-1111-1111-111111111111")
	storedURL  = "http://minio:9000/thc-vms-bucket/profile_photos/pending-111/avatar.jpg"
)

// TestURL_BlankStoredIsNil pins the "no photo" contract: an empty or
// whitespace-only value stays JSON null rather than naming a missing object.
func TestURL_BlankStoredIsNil(t *testing.T) {
	cases := []string{"", "   ", "\t\n"}
	for _, stored := range cases {
		if got := avatarpath.URL(testUserID, stored); got != nil {
			t.Fatalf("URL(%q) = %q, want nil", stored, *got)
		}
	}
}

// TestURL_IsStableAPIPath pins the shape and determinism: the same stored value
// yields the same host-agnostic path, always rooted at /api/v1/avatars/<id>.
func TestURL_IsStableAPIPath(t *testing.T) {
	first := avatarpath.URL(testUserID, storedURL)
	if first == nil {
		t.Fatal("URL returned nil for a stored avatar")
	}
	second := avatarpath.URL(testUserID, storedURL)
	if second == nil || *first != *second {
		t.Fatalf("URL is not stable: %q vs %v", *first, second)
	}
	if !strings.HasPrefix(*first, "/api/v1/avatars/"+string(testUserID)+"?v=") {
		t.Fatalf("path = %q, want /api/v1/avatars/<id>?v=", *first)
	}
	if matched, _ := regexp.MatchString(`^/api/v1/avatars/[^?]+\?v=[0-9a-f]{8}$`, *first); !matched {
		t.Fatalf("path = %q, want 8 lowercase hex version characters", *first)
	}
}

// TestURL_VersionChangesWhenStoredChanges pins the cache-busting rule: a
// re-upload rewrites the stored value and must therefore rewrite the version.
func TestURL_VersionChangesWhenStoredChanges(t *testing.T) {
	first := avatarpath.URL(testUserID, storedURL)
	second := avatarpath.URL(testUserID, storedURL+"?v=2")
	if first == nil || second == nil {
		t.Fatal("URL returned nil for a stored avatar")
	}
	if *first == *second {
		t.Fatalf("version did not change for a different stored value: %q", *first)
	}
}

// TestURL_HasNoStorageHost pins the bug fix: neither the stored host nor a
// scheme may survive into the projected path.
func TestURL_HasNoStorageHost(t *testing.T) {
	got := avatarpath.URL(testUserID, storedURL)
	if got == nil {
		t.Fatal("URL returned nil for a stored avatar")
	}
	for _, forbidden := range []string{"http://", "https://", "minio", "localhost", "9000"} {
		if strings.Contains(*got, forbidden) {
			t.Fatalf("path = %q, must not contain %q", *got, forbidden)
		}
	}
}
