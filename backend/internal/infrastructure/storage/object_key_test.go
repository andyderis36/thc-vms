package storage

import (
	"errors"
	"strings"
	"testing"

	"thc-vms/backend/internal/domain"
)

const testOwnerID = "8f1c1f2e-0000-4000-8000-000000000001"

// Given each supported category, when the object key is built, then the
// directory segment is the storage directory the adapter owns - not a path the
// caller chose. Most directories are the plural of the category token;
// work_photos is the category whose token already is its directory.
func TestBuildObjectKey_MapsCategoriesToStructuredPrefixes(t *testing.T) {
	cases := []struct {
		category string
		want     string
	}{
		{CategoryAssignmentLetter, "assignment_letters/"},
		{CategoryIDCard, "id_cards/"},
		{CategoryCheckinPhoto, "checkin_photos/"},
		{CategoryProfilePhoto, "profile_photos/"},
		{CategoryWorkPhotos, "work_photos/"},
	}

	for _, tc := range cases {
		t.Run(tc.category, func(t *testing.T) {
			key, err := buildObjectKey(tc.category, testOwnerID, "surat-tugas.pdf")
			if err != nil {
				t.Fatalf("buildObjectKey(%q, %q, ...) must succeed, got %v", tc.category, testOwnerID, err)
			}
			want := tc.want + testOwnerID + "/surat-tugas.pdf"
			if key != want {
				t.Fatalf("buildObjectKey(%q) = %q, want %q", tc.category, key, want)
			}
			segments := strings.Split(key, "/")
			if len(segments) != 3 || segments[0] != strings.TrimSuffix(tc.want, "/") || segments[1] != testOwnerID {
				t.Fatalf("key %q must be <directory>/<owner>/<file> with directory %q", key, strings.TrimSuffix(tc.want, "/"))
			}
		})
	}
}

// Given the category directory vocabulary, when the pending prefixes are
// derived, then EVERY writable directory has a staging prefix. Without this a
// category added to categoryDirectories could silently escape the reaper and
// its orphans would never be collected.
func TestPendingPrefixes_CoversEveryCategoryDirectory(t *testing.T) {
	prefixes := PendingPrefixes()
	for category, directory := range categoryDirectories {
		want := directory + "/pending/"
		found := false
		for _, prefix := range prefixes {
			if prefix == want {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("category %q has no pending prefix %q: %v", category, want, prefixes)
		}
	}
	if want := "work_photos/pending/"; !containsString(prefixes, want) {
		t.Fatalf("PendingPrefixes() = %v, want it to contain %q", prefixes, want)
	}
}

// containsString reports whether values holds want.
func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

// Given a hostile or oversized file name, when the object key is built, then
// every directory component is stripped, ".." can never survive, and the
// segment is capped.
func TestBuildObjectKey_SanitizesFilename(t *testing.T) {
	longName := strings.Repeat("a", 300) + ".pdf"

	cases := []struct {
		name     string
		fileName string
		want     string
	}{
		{"parent traversal", "../../etc/passwd", "passwd"},
		{"nested path", "a/b/c.pdf", "c.pdf"},
		{"windows separator", `a\b\c.pdf`, "c.pdf"},
		{"trailing dot segments", "..", rejectKey},
		{"bare parent segment", "../", rejectKey},
		{"empty name", "", rejectKey},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			key, err := buildObjectKey(CategoryCheckinPhoto, testOwnerID, tc.fileName)
			if tc.want == rejectKey {
				if !errors.Is(err, domain.ErrStorageRejected) {
					t.Fatalf("file name %q must be refused with ErrStorageRejected, got key %q err %v", tc.fileName, key, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("file name %q must be sanitised, not refused: %v", tc.fileName, err)
			}
			want := "checkin_photos/" + testOwnerID + "/" + tc.want
			if key != want {
				t.Fatalf("buildObjectKey(%q) = %q, want %q", tc.fileName, key, want)
			}
			if strings.Contains(key, "..") || strings.Contains(key, "a/") {
				t.Fatalf("key %q still carries a directory component", key)
			}
		})
	}

	t.Run("300 char name is capped", func(t *testing.T) {
		key, err := buildObjectKey(CategoryCheckinPhoto, testOwnerID, longName)
		if err != nil {
			t.Fatalf("an over-long but legal name must be truncated, got %v", err)
		}
		segment := strings.TrimPrefix(key, "checkin_photos/"+testOwnerID+"/")
		if len(segment) > maxFileNameLength {
			t.Fatalf("sanitised name is %d chars, want at most %d", len(segment), maxFileNameLength)
		}
		if !strings.HasSuffix(segment, ".pdf") {
			t.Fatalf("truncation must keep the extension, got %q", segment)
		}
	})
}

// Given an unknown category, when the object key is built, then it is refused
// instead of falling back to a caller-chosen directory.
func TestBuildObjectKey_RejectsUnknownCategory(t *testing.T) {
	for _, category := range []string{"", "secrets", "assignment_letters", "id_cards/../..", "work_photo"} {
		key, err := buildObjectKey(category, testOwnerID, "surat-tugas.pdf")
		if !errors.Is(err, domain.ErrStorageRejected) {
			t.Fatalf("category %q must be refused with ErrStorageRejected, got key %q err %v", category, key, err)
		}
	}
}

// Given a traversal attempt in the owning id, when the object key is built,
// then it is refused before it can escape the mandated directory.
func TestBuildObjectKey_RejectsUnsafeOwnerID(t *testing.T) {
	for _, ownerID := range []string{"", "..", "../secrets", "a/b", "a b", strings.Repeat("z", maxOwnerIDLength+1)} {
		key, err := buildObjectKey(CategoryIDCard, ownerID, "ktp.png")
		if !errors.Is(err, domain.ErrStorageRejected) {
			t.Fatalf("owner id %q must be refused with ErrStorageRejected, got key %q err %v", ownerID, key, err)
		}
	}
}

// Given the "category/owner" hint a caller puts in UploadRequest.ObjectKey,
// when it is split, then the two segments are returned verbatim.
func TestSplitObjectKeyHint(t *testing.T) {
	t.Run("well formed hint", func(t *testing.T) {
		category, ownerID, err := splitObjectKeyHint(CategoryCheckinPhoto + "/" + testOwnerID)
		if err != nil {
			t.Fatalf("a well-formed hint must split, got %v", err)
		}
		if category != CategoryCheckinPhoto || ownerID != testOwnerID {
			t.Fatalf("splitObjectKeyHint = (%q, %q), want (%q, %q)", category, ownerID, CategoryCheckinPhoto, testOwnerID)
		}
	})

	t.Run("malformed hints", func(t *testing.T) {
		for _, hint := range []string{"", "checkin_photo", "/", "a/b/c", "checkin_photo/"} {
			if _, _, err := splitObjectKeyHint(hint); !errors.Is(err, domain.ErrStorageRejected) {
				t.Fatalf("hint %q must be refused with ErrStorageRejected, got %v", hint, err)
			}
		}
	})
}
