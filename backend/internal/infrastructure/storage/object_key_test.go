package storage

import (
	"errors"
	"strings"
	"testing"

	"thc-vms/backend/internal/domain"
)

const testOwnerID = "8f1c1f2e-0000-4000-8000-000000000001"

// Given each supported category, when the object key is built, then the
// directory segment is the plural name mandated by AGENTS.md 6.4 - the
// category token itself never reaches the key.
func TestBuildObjectKey_MapsCategoriesToStructuredPrefixes(t *testing.T) {
	cases := []struct {
		category string
		want     string
	}{
		{CategoryAssignmentLetter, "assignment_letters/"},
		{CategoryIDCard, "id_cards/"},
		{CategoryCheckinPhoto, "checkin_photos/"},
		{CategoryProfilePhoto, "profile_photos/"},
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
			if strings.Contains(key, tc.category) {
				// The mandated directory names are the PLURAL of the category
				// token ("assignment_letter" -> "assignment_letters"), so a
				// substring check can never pass. What must hold is that the
				// caller's token is not used verbatim as the directory: the
				// adapter, not the caller, picks the layout.
				firstSegment := strings.SplitN(key, "/", 2)[0]
				if firstSegment == tc.category {
					t.Fatalf("key %q must not use the raw category token as its directory", key)
				}
			}
		})
	}
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
	for _, category := range []string{"", "secrets", "assignment_letters", "id_cards/../.."} {
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
