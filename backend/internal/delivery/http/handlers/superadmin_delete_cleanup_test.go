package handlers_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/handlers"
	"thc-vms/backend/internal/domain"
)

// cleanupRecorder is a hand-written fake for domain.IStorageService on the
// delete-path cleanup: it records every DeleteObject call and reverses stored
// URLs against its own bucket segment (the adapter's full-segment rule), so
// the handler tests can assert exactly which keys a purge handed over.
type cleanupRecorder struct {
	bucket    string
	deleted   []string
	deleteErr error
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

// cleanupURL builds a stored absolute URL the recorder can reverse.
func cleanupURL(key string) string {
	return "https://cdn.example.com/thc-bucket/" + key
}

// stubCheckIns is a hand-written fake for domain.CheckInOutRepository on the
// visit-purge path: only FindCheckInByVisit is functional (seeded per visit,
// ErrNotFound otherwise); the writers satisfy the interface and are never
// exercised here.
type stubCheckIns struct {
	byVisit map[domain.UUID]domain.CheckIn
}

func (s *stubCheckIns) RecordCheckIn(_ context.Context, checkIn domain.CheckIn) (domain.CheckIn, error) {
	return checkIn, nil
}

func (s *stubCheckIns) RecordCheckOut(_ context.Context, checkOut domain.CheckOut) (domain.CheckOut, error) {
	return checkOut, nil
}

func (s *stubCheckIns) FindCheckInByVisit(_ context.Context, visitID domain.UUID) (domain.CheckIn, error) {
	checkIn, ok := s.byVisit[visitID]
	if !ok {
		return domain.CheckIn{}, domain.ErrNotFound
	}
	return checkIn, nil
}

func (s *stubCheckIns) FindCheckOutByVisit(_ context.Context, _ domain.UUID) (domain.CheckOut, error) {
	return domain.CheckOut{}, domain.ErrNotFound
}

// newCleanupEngine wires the two purge routes with the storage port and the
// check-in port attached, so the tests exercise the real collect → delete →
// batch sequence end to end.
func newCleanupEngine(users *stubManagedUsers, visits *stubVisitRepos, checkins domain.CheckInOutRepository, storage domain.IStorageService) *gin.Engine {
	engine := gin.New()
	engine.Use(withActor(domain.RoleSuperAdmin, ""))
	locations := newStubLocationAdmin()
	h := handlers.NewSuperAdminHandler(users, locations, locations, visits, "role-admin", "role-vendor").
		WithStorage(storage).
		WithCheckIns(checkins)
	engine.DELETE("/users/:id", h.DeleteUser)
	engine.DELETE("/visits/:id", h.DeleteVisit)
	return engine
}

func TestSuperAdmin_DeleteUser_StorageCleanup(t *testing.T) {
	t.Run("204 purges the avatar object after the row delete", func(t *testing.T) {
		account := managedAccount("target-1", "admin@thc.local", domain.RoleAdmin, nil)
		account.User.AvatarURL = cleanupURL("profile_photos/target-1/avatar.jpg")
		users := newStubManagedUsers(account)
		storage := newCleanupRecorder()
		engine := newCleanupEngine(users, newStubVisitRepos(), &stubCheckIns{}, storage)

		rec := serve(engine, "DELETE", "/users/target-1", nil, "")
		mustStatus(t, rec, http.StatusNoContent)
		if len(users.deletedUsers) != 1 || users.deletedUsers[0] != "target-1" {
			t.Fatalf("store must hold the deletion, got %+v", users.deletedUsers)
		}
		want := []string{"profile_photos/target-1/avatar.jpg"}
		if len(storage.deleted) != len(want) || storage.deleted[0] != want[0] {
			t.Fatalf("storage deleted = %v, want %v", storage.deleted, want)
		}
	})

	t.Run("500 on DB failure makes zero storage calls", func(t *testing.T) {
		account := managedAccount("target-1", "admin@thc.local", domain.RoleAdmin, nil)
		account.User.AvatarURL = cleanupURL("profile_photos/target-1/avatar.jpg")
		users := newStubManagedUsers(account)
		users.deleteUserErr = domain.ErrDatabase
		storage := newCleanupRecorder()
		engine := newCleanupEngine(users, newStubVisitRepos(), &stubCheckIns{}, storage)

		rec := serve(engine, "DELETE", "/users/target-1", nil, "")
		mustStatus(t, rec, http.StatusInternalServerError)
		if len(users.deletedUsers) != 0 {
			t.Fatalf("failed delete must not touch the store, got %+v", users.deletedUsers)
		}
		if len(storage.deleted) != 0 {
			t.Fatalf("storage deleted = %v, want zero calls on DB failure", storage.deleted)
		}
	})
}

// seededCleanupVisit carries every URL member a visit purge cascades over:
// the assignment letter, one technician with KTP + selfie, and (via the
// check-in stub) the gate photo.
func seededCleanupVisit() domain.VisitRequest {
	return domain.VisitRequest{
		ID:                  "visit-1",
		VisitID:             "VST-CLEAN01",
		AssignmentLetterURL: strPtr(cleanupURL("assignment_letters/visit-1/spk.pdf")),
		Visitors: []domain.Visitor{{
			ID:             "vis-1",
			IDCardPhotoURL: strPtr(cleanupURL("id_cards/vis-1/ktp.jpg")),
			PhotoURL:       strPtr(cleanupURL("profile_photos/vis-1/selfie.jpg")),
		}},
	}
}

func TestSuperAdmin_DeleteVisit_StorageCleanup(t *testing.T) {
	t.Run("204 purges letter, visitor photos and check-in photo after the row delete", func(t *testing.T) {
		visits := newStubVisitRepos("visit-1")
		visits.seeded = map[domain.UUID]domain.VisitRequest{"visit-1": seededCleanupVisit()}
		checkins := &stubCheckIns{byVisit: map[domain.UUID]domain.CheckIn{
			"visit-1": {
				ID: "ci-1",
				PhotoURL: strPtr(cleanupURL("checkin_photos/visit-1/gate.jpg")),
			},
		}}
		storage := newCleanupRecorder()
		engine := newCleanupEngine(newStubManagedUsers(), visits, checkins, storage)

		rec := serve(engine, "DELETE", "/visits/visit-1", nil, "")
		mustStatus(t, rec, http.StatusNoContent)
		if len(visits.deleted) != 1 || visits.deleted[0] != "visit-1" {
			t.Fatalf("store must hold the purge, got %+v", visits.deleted)
		}
		want := []string{
			"assignment_letters/visit-1/spk.pdf",
			"id_cards/vis-1/ktp.jpg",
			"profile_photos/vis-1/selfie.jpg",
			"checkin_photos/visit-1/gate.jpg",
		}
		if len(storage.deleted) != len(want) {
			t.Fatalf("storage deleted = %v, want %v", storage.deleted, want)
		}
		for i := range want {
			if storage.deleted[i] != want[i] {
				t.Fatalf("storage deleted = %v, want %v", storage.deleted, want)
			}
		}
	})

	t.Run("204 without a check-in skips only the gate photo", func(t *testing.T) {
		visits := newStubVisitRepos("visit-1")
		visits.seeded = map[domain.UUID]domain.VisitRequest{"visit-1": seededCleanupVisit()}
		storage := newCleanupRecorder()
		engine := newCleanupEngine(newStubManagedUsers(), visits, &stubCheckIns{}, storage)

		rec := serve(engine, "DELETE", "/visits/visit-1", nil, "")
		mustStatus(t, rec, http.StatusNoContent)
		want := []string{
			"assignment_letters/visit-1/spk.pdf",
			"id_cards/vis-1/ktp.jpg",
			"profile_photos/vis-1/selfie.jpg",
		}
		if len(storage.deleted) != len(want) {
			t.Fatalf("storage deleted = %v, want %v", storage.deleted, want)
		}
		for i := range want {
			if storage.deleted[i] != want[i] {
				t.Fatalf("storage deleted = %v, want %v", storage.deleted, want)
			}
		}
	})

	t.Run("500 on DB failure makes zero storage calls", func(t *testing.T) {
		visits := newStubVisitRepos("visit-1")
		visits.seeded = map[domain.UUID]domain.VisitRequest{"visit-1": seededCleanupVisit()}
		visits.deleteErr = domain.ErrDatabase
		checkins := &stubCheckIns{byVisit: map[domain.UUID]domain.CheckIn{
			"visit-1": {
				ID: "ci-1",
				PhotoURL: strPtr(cleanupURL("checkin_photos/visit-1/gate.jpg")),
			},
		}}
		storage := newCleanupRecorder()
		engine := newCleanupEngine(newStubManagedUsers(), visits, checkins, storage)

		rec := serve(engine, "DELETE", "/visits/visit-1", nil, "")
		mustStatus(t, rec, http.StatusInternalServerError)
		if len(visits.deleted) != 0 {
			t.Fatalf("failed purge must not touch the store, got %+v", visits.deleted)
		}
		if len(storage.deleted) != 0 {
			t.Fatalf("storage deleted = %v, want zero calls on DB failure", storage.deleted)
		}
	})
}
