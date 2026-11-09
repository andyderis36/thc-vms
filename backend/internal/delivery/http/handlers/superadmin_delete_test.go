package handlers_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/handlers"
	"thc-vms/backend/internal/domain"
)

// stubVisitRepos is a hand-written fake for domain.VisitRepository on the
// super_admin purge path. Only DeleteVisit is functional: a missing id is
// ErrNotFound (mirroring MapError's pgx.ErrNoRows mapping) and the delete
// drops the row, which stands in for the production ON DELETE CASCADE over
// the child tables. The other members satisfy the interface for engine
// construction and are never exercised by the delete tests.
type stubVisitRepos struct {
	existing  map[domain.UUID]bool
	deleted   []domain.UUID
	deleteErr error
	// seeded carries full visit rows (letter URL, visitor roster) for the
	// storage-cleanup tests; FindByID prefers a seeded row over the bare
	// id shell and stays behaviour-identical when the map is nil.
	seeded map[domain.UUID]domain.VisitRequest
}

func newStubVisitRepos(ids ...domain.UUID) *stubVisitRepos {
	s := &stubVisitRepos{existing: map[domain.UUID]bool{}}
	for _, id := range ids {
		s.existing[id] = true
	}
	return s
}

func (s *stubVisitRepos) Create(_ context.Context, visit domain.VisitRequest, _ []domain.Visitor, _ []domain.UUID) (domain.VisitRequest, error) {
	return visit, nil
}

func (s *stubVisitRepos) FindByID(_ context.Context, id domain.UUID) (domain.VisitRequest, error) {
	if !s.existing[id] {
		return domain.VisitRequest{}, domain.ErrNotFound
	}
	if row, ok := s.seeded[id]; ok {
		return row, nil
	}
	return domain.VisitRequest{ID: id}, nil
}

func (s *stubVisitRepos) FindByVisitCode(_ context.Context, _ string) (domain.VisitRequest, error) {
	return domain.VisitRequest{}, domain.ErrNotFound
}

func (s *stubVisitRepos) ListStatusHistory(_ context.Context, _ domain.UUID) ([]domain.StatusEvent, error) {
	return nil, nil
}

func (s *stubVisitRepos) List(_ context.Context, _ domain.VisitFilter) ([]domain.VisitRequest, int64, error) {
	return nil, 0, nil
}

func (s *stubVisitRepos) UpdateStatus(_ context.Context, _ domain.UUID, _ domain.VisitStatus, _ domain.UUID, _ string) error {
	return nil
}

func (s *stubVisitRepos) Reschedule(_ context.Context, _ domain.UUID, _, _ time.Time, _ domain.UUID, _ string) error {
	return nil
}

func (s *stubVisitRepos) ListVisitorJabatan(_ context.Context) ([]string, error) {
	return nil, nil
}

func (s *stubVisitRepos) UpdateVisitorContact(_ context.Context, _, _ domain.UUID, _ string, _ bool) (domain.Visitor, error) {
	return domain.Visitor{}, domain.ErrNotFound
}

func (s *stubVisitRepos) DeleteVisit(_ context.Context, id domain.UUID) error {
	if s.deleteErr != nil {
		return s.deleteErr
	}
	if !s.existing[id] {
		return domain.ErrNotFound
	}
	s.deleted = append(s.deleted, id)
	delete(s.existing, id)
	return nil
}

func (s *stubVisitRepos) AttachWorkPhoto(_ context.Context, _ domain.UUID, _ domain.WorkPhotoKind, _ string, _ domain.UUID) (domain.WorkPhoto, bool, error) {
	return domain.WorkPhoto{}, false, domain.ErrNotFound
}

func (s *stubVisitRepos) ListWorkPhotos(_ context.Context, _ domain.UUID) ([]domain.WorkPhoto, error) {
	return nil, nil
}

// newDeleteEngine wires the three DELETE routes with injectable fakes so the
// delete tests control the reference counts and the stored rows.
func newDeleteEngine(users *stubManagedUsers, locations *stubLocationAdmin, visits *stubVisitRepos, role domain.RoleName) *gin.Engine {
	engine := gin.New()
	engine.Use(withActor(role, ""))
	h := handlers.NewSuperAdminHandler(users, locations, locations, visits, "role-admin", "role-vendor")
	engine.DELETE("/users/:id", h.DeleteUser)
	engine.DELETE("/locations/:id", h.DeleteLocation)
	engine.DELETE("/purposes/:id", h.DeletePurpose)
	engine.DELETE("/visits/:id", h.DeleteVisit)
	return engine
}

func TestSuperAdmin_DeleteUser(t *testing.T) {
	t.Run("204 removes an unreferenced admin with no body", func(t *testing.T) {
		users := newStubManagedUsers(managedAccount("target-1", "admin@thc.local", domain.RoleAdmin, nil))
		engine := newDeleteEngine(users, newStubLocationAdmin(), newStubVisitRepos(), domain.RoleSuperAdmin)

		rec := serve(engine, "DELETE", "/users/target-1", nil, "")
		mustStatus(t, rec, http.StatusNoContent)
		if rec.Body.Len() != 0 {
			t.Fatalf("204 must carry no body, got %q", rec.Body.String())
		}
		if len(users.deletedUsers) != 1 || users.deletedUsers[0] != "target-1" {
			t.Fatalf("store must hold the deletion, got %+v", users.deletedUsers)
		}
	})

	t.Run("404 unknown id", func(t *testing.T) {
		users := newStubManagedUsers()
		engine := newDeleteEngine(users, newStubLocationAdmin(), newStubVisitRepos(), domain.RoleSuperAdmin)

		rec := serve(engine, "DELETE", "/users/ghost", nil, "")
		mustStatus(t, rec, http.StatusNotFound)
		env := decodeEnvelope(t, rec)
		if env.Error == nil || env.Error.Code != "NOT_FOUND" || env.Error.Message != "Akun tidak ditemukan." {
			t.Fatalf("unknown id must be the Akun 404, got %q", rec.Body.String())
		}
		if len(users.deletedUsers) != 0 {
			t.Fatal("refused delete must not touch the store")
		}
	})

	t.Run("403 self with the contract sentence", func(t *testing.T) {
		users := newStubManagedUsers(
			managedAccount("actor-1", "saya@thc.local", domain.RoleSuperAdmin, nil),
		)
		engine := newDeleteEngine(users, newStubLocationAdmin(), newStubVisitRepos(), domain.RoleSuperAdmin)

		rec := serve(engine, "DELETE", "/users/actor-1", nil, "")
		mustStatus(t, rec, http.StatusForbidden)
		env := decodeEnvelope(t, rec)
		if env.Error == nil || env.Error.Message != "Tidak dapat menghapus akun sendiri." {
			t.Fatalf("self-delete must carry the contract sentence, got %q", rec.Body.String())
		}
		if len(users.deletedUsers) != 0 {
			t.Fatal("refused delete must not touch the store")
		}
	})

	t.Run("403 other super_admin with the contract sentence", func(t *testing.T) {
		users := newStubManagedUsers(
			managedAccount("target-9", "pusat@thc.local", domain.RoleSuperAdmin, nil),
		)
		engine := newDeleteEngine(users, newStubLocationAdmin(), newStubVisitRepos(), domain.RoleSuperAdmin)

		rec := serve(engine, "DELETE", "/users/target-9", nil, "")
		mustStatus(t, rec, http.StatusForbidden)
		env := decodeEnvelope(t, rec)
		if env.Error == nil || env.Error.Message != "Akun superadmin tidak dapat dihapus." {
			t.Fatalf("superadmin-delete must carry the contract sentence, got %q", rec.Body.String())
		}
		if len(users.deletedUsers) != 0 {
			t.Fatal("refused delete must not touch the store")
		}
	})

	t.Run("409 when the vendor still owns visits", func(t *testing.T) {
		users := newStubManagedUsers(managedAccount("vendor-1", "tek@vendor.local", domain.RoleVendor, nil))
		users.visitsByVendor["vendor-1"] = 2
		engine := newDeleteEngine(users, newStubLocationAdmin(), newStubVisitRepos(), domain.RoleSuperAdmin)

		rec := serve(engine, "DELETE", "/users/vendor-1", nil, "")
		mustStatus(t, rec, http.StatusConflict)
		env := decodeEnvelope(t, rec)
		if env.Error == nil || env.Error.Code != "CONFLICT" || env.Error.Message == "" {
			t.Fatalf("owned visits must be 409 CONFLICT, got %q", rec.Body.String())
		}
		if len(users.deletedUsers) != 0 {
			t.Fatal("refused delete must not touch the store")
		}
	})

	t.Run("409 when staff is still named on gate or audit rows", func(t *testing.T) {
		users := newStubManagedUsers(managedAccount("sec-1", "security@thc.local", domain.RoleSecurity, nil))
		users.staffRefs["sec-1"] = 3
		engine := newDeleteEngine(users, newStubLocationAdmin(), newStubVisitRepos(), domain.RoleSuperAdmin)

		rec := serve(engine, "DELETE", "/users/sec-1", nil, "")
		mustStatus(t, rec, http.StatusConflict)
		env := decodeEnvelope(t, rec)
		if env.Error == nil || env.Error.Code != "CONFLICT" || env.Error.Message == "" {
			t.Fatalf("staff references must be 409 CONFLICT, got %q", rec.Body.String())
		}
		if len(users.deletedUsers) != 0 {
			t.Fatal("refused delete must not touch the store")
		}
	})
}

func TestSuperAdmin_DeleteLocation(t *testing.T) {
	t.Run("204 removes an unreferenced facility with no body", func(t *testing.T) {
		locations := newStubLocationAdmin(domain.Location{
			ID: "loc-1", Name: "POP Kosong", Type: domain.LocationPOP,
			Timezone: domain.TimezoneWIB, IsActive: true,
		})
		engine := newDeleteEngine(newStubManagedUsers(), locations, newStubVisitRepos(), domain.RoleSuperAdmin)

		rec := serve(engine, "DELETE", "/locations/loc-1", nil, "")
		mustStatus(t, rec, http.StatusNoContent)
		if rec.Body.Len() != 0 {
			t.Fatalf("204 must carry no body, got %q", rec.Body.String())
		}
		if len(locations.deletedLocs) != 1 || locations.deletedLocs[0] != "loc-1" {
			t.Fatalf("store must hold the deletion, got %+v", locations.deletedLocs)
		}
	})

	t.Run("404 unknown id", func(t *testing.T) {
		locations := newStubLocationAdmin()
		engine := newDeleteEngine(newStubManagedUsers(), locations, newStubVisitRepos(), domain.RoleSuperAdmin)

		rec := serve(engine, "DELETE", "/locations/loc-ghost", nil, "")
		mustStatus(t, rec, http.StatusNotFound)
		env := decodeEnvelope(t, rec)
		if env.Error == nil || env.Error.Code != "NOT_FOUND" || env.Error.Message != "Fasilitas tidak ditemukan." {
			t.Fatalf("unknown id must be the Fasilitas 404, got %q", rec.Body.String())
		}
	})

	t.Run("409 while users are still stationed there", func(t *testing.T) {
		locations := newStubLocationAdmin(domain.Location{
			ID: "loc-1", Name: "Cabang Ramai", Type: domain.LocationCabang,
			Timezone: domain.TimezoneWIB, IsActive: true,
		})
		locations.usersAt["loc-1"] = 2
		engine := newDeleteEngine(newStubManagedUsers(), locations, newStubVisitRepos(), domain.RoleSuperAdmin)

		rec := serve(engine, "DELETE", "/locations/loc-1", nil, "")
		mustStatus(t, rec, http.StatusConflict)
		env := decodeEnvelope(t, rec)
		if env.Error == nil || env.Error.Code != "CONFLICT" || env.Error.Message == "" {
			t.Fatalf("stationed users must be 409 CONFLICT, got %q", rec.Body.String())
		}
		if len(locations.deletedLocs) != 0 {
			t.Fatal("refused delete must not touch the store")
		}
	})

	t.Run("409 while visits are still hosted there", func(t *testing.T) {
		locations := newStubLocationAdmin(domain.Location{
			ID: "loc-1", Name: "Cabang Ramai", Type: domain.LocationCabang,
			Timezone: domain.TimezoneWIB, IsActive: true,
		})
		locations.visitsAt["loc-1"] = 5
		engine := newDeleteEngine(newStubManagedUsers(), locations, newStubVisitRepos(), domain.RoleSuperAdmin)

		rec := serve(engine, "DELETE", "/locations/loc-1", nil, "")
		mustStatus(t, rec, http.StatusConflict)
		env := decodeEnvelope(t, rec)
		if env.Error == nil || env.Error.Code != "CONFLICT" || env.Error.Message == "" {
			t.Fatalf("hosted visits must be 409 CONFLICT, got %q", rec.Body.String())
		}
		if len(locations.deletedLocs) != 0 {
			t.Fatal("refused delete must not touch the store")
		}
	})
}

func TestSuperAdmin_DeleteVisit(t *testing.T) {
	t.Run("204 purges any visit with no body", func(t *testing.T) {
		visits := newStubVisitRepos("visit-1")
		engine := newDeleteEngine(newStubManagedUsers(), newStubLocationAdmin(), visits, domain.RoleSuperAdmin)

		rec := serve(engine, "DELETE", "/visits/visit-1", nil, "")
		mustStatus(t, rec, http.StatusNoContent)
		if rec.Body.Len() != 0 {
			t.Fatalf("204 must carry no body, got %q", rec.Body.String())
		}
		if len(visits.deleted) != 1 || visits.deleted[0] != "visit-1" {
			t.Fatalf("store must hold the purge, got %+v", visits.deleted)
		}
	})

	t.Run("404 unknown id", func(t *testing.T) {
		visits := newStubVisitRepos()
		engine := newDeleteEngine(newStubManagedUsers(), newStubLocationAdmin(), visits, domain.RoleSuperAdmin)

		rec := serve(engine, "DELETE", "/visits/ghost", nil, "")
		mustStatus(t, rec, http.StatusNotFound)
		env := decodeEnvelope(t, rec)
		if env.Error == nil || env.Error.Code != "NOT_FOUND" || env.Error.Message != "Kunjungan tidak ditemukan." {
			t.Fatalf("unknown id must be the Kunjungan 404, got %q", rec.Body.String())
		}
	})
}

func TestSuperAdmin_DeleteForbiddenForNonSuperAdmin(t *testing.T) {
	users := newStubManagedUsers(managedAccount("target-1", "admin@thc.local", domain.RoleAdmin, nil))
	locations := newStubLocationAdmin(domain.Location{
		ID: "loc-1", Name: "Cabang A", Type: domain.LocationCabang,
		Timezone: domain.TimezoneWIB, IsActive: true,
	})
	visits := newStubVisitRepos("visit-1")
	engine := newDeleteEngine(users, locations, visits, domain.RoleAdmin)

	for _, path := range []string{"/users/target-1", "/locations/loc-1", "/visits/visit-1"} {
		rec := serve(engine, "DELETE", path, nil, "")
		mustStatus(t, rec, http.StatusForbidden)
		env := decodeEnvelope(t, rec)
		if env.Error == nil || env.Error.Message != domain.ErrForbiddenBranch.Error() {
			t.Fatalf("DELETE %s: refusal must carry the sentinel message, got %q", path, rec.Body.String())
		}
	}
	if len(users.deletedUsers) != 0 || len(locations.deletedLocs) != 0 || len(visits.deleted) != 0 {
		t.Fatal("forbidden deletes must not touch any store")
	}
}
