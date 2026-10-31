package superadmin_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/superadmin"
)

// cleanupRecorder is a hand-written fake for domain.IStorageService behind
// the delete-path cleanup: it records every DeleteObject call (optionally
// mirroring each into a shared event log so a test can prove ordering) and
// reverses stored URLs against its own bucket segment, the same
// full-segment rule the adapter applies.
type cleanupRecorder struct {
	bucket    string
	deleted   []string
	deleteErr error
	events    *[]string
}

func newCleanupRecorder() *cleanupRecorder {
	return &cleanupRecorder{bucket: "thc-bucket"}
}

func (r *cleanupRecorder) EnsureBucket(context.Context) error { return nil }

func (r *cleanupRecorder) Upload(context.Context, domain.UploadRequest) (domain.UploadResult, error) {
	return domain.UploadResult{}, nil
}

func (r *cleanupRecorder) PresignedURL(context.Context, string, time.Duration) (string, error) {
	return "", nil
}

func (r *cleanupRecorder) DeleteObject(_ context.Context, key string) error {
	if r.events != nil {
		*r.events = append(*r.events, "obj:"+key)
	}
	r.deleted = append(r.deleted, key)
	return r.deleteErr
}

func (r *cleanupRecorder) ObjectKeyFromStoredURL(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", domain.ErrValidation
	}
	marker := "/" + r.bucket + "/"
	idx := strings.Index(trimmed, marker)
	if idx < 0 {
		return "", domain.ErrValidation
	}
	key := trimmed[idx+len(marker):]
	if i := strings.IndexAny(key, "?#"); i >= 0 {
		key = key[:i]
	}
	if key == "" {
		return "", domain.ErrValidation
	}
	return key, nil
}

// storedURL builds a stored absolute URL the recorder can reverse.
func storedURL(key string) string {
	return "https://cdn.example.com/thc-bucket/" + key
}

// cleanupStrPtr boxes a string for the optional *string URL members.
func cleanupStrPtr(s string) *string { return &s }

func TestCollectUserStorageKeys(t *testing.T) {
	storage := newCleanupRecorder()

	t.Run("collects the avatar key from the seeded row", func(t *testing.T) {
		target := domain.ManagedUser{User: domain.User{
			ID: "user-1", AvatarURL: storedURL("profile_photos/user-1/avatar.jpg"),
		}}
		keys := superadmin.CollectUserStorageKeys(storage, target)
		want := []string{"profile_photos/user-1/avatar.jpg"}
		if len(keys) != len(want) || keys[0] != want[0] {
			t.Fatalf("keys = %v, want %v", keys, want)
		}
	})

	t.Run("skips a blank avatar", func(t *testing.T) {
		keys := superadmin.CollectUserStorageKeys(storage, domain.ManagedUser{})
		if len(keys) != 0 {
			t.Fatalf("keys = %v, want none for a blank avatar", keys)
		}
	})

	t.Run("skips a URL outside our bucket", func(t *testing.T) {
		target := domain.ManagedUser{User: domain.User{
			ID: "user-1", AvatarURL: "https://evil.example.com/other-bucket/profile_photos/x/a.jpg",
		}}
		if keys := superadmin.CollectUserStorageKeys(storage, target); len(keys) != 0 {
			t.Fatalf("keys = %v, want none for a foreign URL", keys)
		}
	})

	t.Run("nil storage collects nothing", func(t *testing.T) {
		target := domain.ManagedUser{User: domain.User{
			ID: "user-1", AvatarURL: storedURL("profile_photos/user-1/avatar.jpg"),
		}}
		if keys := superadmin.CollectUserStorageKeys(nil, target); keys != nil {
			t.Fatalf("keys = %v, want nil when storage is unwired", keys)
		}
	})
}

// seededVisit carries every URL member a visit purge cascades over: the
// assignment letter plus two technicians with a KTP and a selfie each.
func seededVisit() domain.VisitRequest {
	return domain.VisitRequest{
		ID:                  "visit-1",
		VisitID:             "VST-TEST0001",
		AssignmentLetterURL: cleanupStrPtr(storedURL("assignment_letters/visit-1/spk.pdf")),
		Visitors: []domain.Visitor{
			{
				ID:             "vis-1",
				IDCardPhotoURL: cleanupStrPtr(storedURL("id_cards/vis-1/ktp.jpg")),
				PhotoURL:       cleanupStrPtr(storedURL("profile_photos/vis-1/selfie.jpg")),
			},
			{
				ID:             "vis-2",
				IDCardPhotoURL: cleanupStrPtr(storedURL("id_cards/vis-2/ktp.jpg")),
				PhotoURL:       cleanupStrPtr(storedURL("profile_photos/vis-2/selfie.jpg")),
			},
		},
	}
}

func TestCollectVisitStorageKeys(t *testing.T) {
	storage := newCleanupRecorder()
	seeded := seededVisit()
	checkIn := &domain.CheckIn{
		ID: "ci-1", PhotoURL: cleanupStrPtr(storedURL("checkin_photos/visit-1/gate.jpg")),
	}

	t.Run("collects every key kind the cascade would orphan", func(t *testing.T) {
		keys := superadmin.CollectVisitStorageKeys(storage, seeded, checkIn)
		want := []string{
			"assignment_letters/visit-1/spk.pdf",
			"id_cards/vis-1/ktp.jpg",
			"profile_photos/vis-1/selfie.jpg",
			"id_cards/vis-2/ktp.jpg",
			"profile_photos/vis-2/selfie.jpg",
			"checkin_photos/visit-1/gate.jpg",
		}
		if len(keys) != len(want) {
			t.Fatalf("keys = %v, want %v", keys, want)
		}
		for i := range want {
			if keys[i] != want[i] {
				t.Fatalf("keys = %v, want %v", keys, want)
			}
		}
	})

	t.Run("omits the check-in key when the visit never checked in", func(t *testing.T) {
		keys := superadmin.CollectVisitStorageKeys(storage, seeded, nil)
		if len(keys) != 5 {
			t.Fatalf("keys = %v, want the five row keys", keys)
		}
		for _, key := range keys {
			if strings.HasPrefix(key, "checkin_photos/") {
				t.Fatalf("keys = %v, want no checkin_photos key without a check-in", keys)
			}
		}
	})

	t.Run("skips blank and nil URL members", func(t *testing.T) {
		visit := domain.VisitRequest{
			Visitors: []domain.Visitor{{
				ID: "vis-1", IDCardPhotoURL: cleanupStrPtr(""), PhotoURL: nil,
			}},
		}
		if keys := superadmin.CollectVisitStorageKeys(storage, visit, nil); len(keys) != 0 {
			t.Fatalf("keys = %v, want none for blank URLs", keys)
		}
	})

	t.Run("nil storage collects nothing", func(t *testing.T) {
		if keys := superadmin.CollectVisitStorageKeys(nil, seeded, checkIn); keys != nil {
			t.Fatalf("keys = %v, want nil when storage is unwired", keys)
		}
	})
}

func TestDeleteRowThenObjects(t *testing.T) {
	// Duplicate and blank members: the batch must collapse them so the same
	// URL stored on two rows is deleted exactly once.
	keys := []string{
		"profile_photos/user-1/avatar.jpg",
		"assignment_letters/visit-1/spk.pdf",
		"profile_photos/user-1/avatar.jpg",
		"",
	}

	t.Run("runs one deduped batch after a successful row delete", func(t *testing.T) {
		var events []string
		storage := newCleanupRecorder()
		storage.events = &events
		rowCalls := 0

		err := superadmin.DeleteRowThenObjects(context.Background(), storage, keys, func() error {
			rowCalls++
			events = append(events, "row")
			return nil
		})
		if err != nil {
			t.Fatalf("DeleteRowThenObjects = %v, want nil", err)
		}
		if rowCalls != 1 {
			t.Fatalf("row delete calls = %d, want exactly 1", rowCalls)
		}
		// The row event must come first (post-commit), then ONE contiguous
		// object batch carrying the deduped set in first-seen order.
		want := []string{
			"row",
			"obj:profile_photos/user-1/avatar.jpg",
			"obj:assignment_letters/visit-1/spk.pdf",
		}
		if len(events) != len(want) {
			t.Fatalf("events = %v, want %v", events, want)
		}
		for i := range want {
			if events[i] != want[i] {
				t.Fatalf("events = %v, want %v", events, want)
			}
		}
		if len(storage.deleted) != 2 ||
			storage.deleted[0] != "profile_photos/user-1/avatar.jpg" ||
			storage.deleted[1] != "assignment_letters/visit-1/spk.pdf" {
			t.Fatalf("deleted = %v, want each deduped key exactly once", storage.deleted)
		}
	})

	t.Run("row failure makes zero storage calls", func(t *testing.T) {
		storage := newCleanupRecorder()
		sentinel := errors.New("db down")

		err := superadmin.DeleteRowThenObjects(context.Background(), storage, keys, func() error {
			return sentinel
		})
		if !errors.Is(err, sentinel) {
			t.Fatalf("err = %v, want the row error verbatim", err)
		}
		if len(storage.deleted) != 0 {
			t.Fatalf("deleted = %v, want zero storage calls on row failure", storage.deleted)
		}
	})

	t.Run("storage failure never fails the committed delete", func(t *testing.T) {
		storage := newCleanupRecorder()
		storage.deleteErr = errors.New("minio unreachable")

		err := superadmin.DeleteRowThenObjects(context.Background(), storage, keys, func() error {
			return nil
		})
		if err != nil {
			t.Fatalf("DeleteRowThenObjects = %v, want nil while storage fails", err)
		}
		if len(storage.deleted) != 2 {
			t.Fatalf("deleted = %v, want both keys attempted", storage.deleted)
		}
	})

	t.Run("empty key set runs the row delete and skips storage", func(t *testing.T) {
		storage := newCleanupRecorder()
		rowCalls := 0

		err := superadmin.DeleteRowThenObjects(context.Background(), storage, nil, func() error {
			rowCalls++
			return nil
		})
		if err != nil {
			t.Fatalf("DeleteRowThenObjects = %v, want nil", err)
		}
		if rowCalls != 1 {
			t.Fatalf("row delete calls = %d, want 1", rowCalls)
		}
		if len(storage.deleted) != 0 {
			t.Fatalf("deleted = %v, want zero storage calls for an empty set", storage.deleted)
		}
	})

	t.Run("nil storage still runs the row delete", func(t *testing.T) {
		rowCalls := 0
		err := superadmin.DeleteRowThenObjects(context.Background(), nil, keys, func() error {
			rowCalls++
			return nil
		})
		if err != nil {
			t.Fatalf("DeleteRowThenObjects = %v, want nil", err)
		}
		if rowCalls != 1 {
			t.Fatalf("row delete calls = %d, want 1", rowCalls)
		}
	})
}
