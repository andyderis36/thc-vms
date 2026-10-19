package handlers_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/handlers"
	"thc-vms/backend/internal/domain"
)

// fakeAuditRepo is a hand-written fake for domain.AuditRepository: it records
// every appended entry in order. The stubs below predate the Audited* ports,
// so every handler here exercises the best-effort fallback; the
// same-transaction half is proven by the repository integration tests.
type fakeAuditRepo struct {
	entries []domain.AuditEntry
}

func (f *fakeAuditRepo) Append(_ context.Context, entry domain.AuditEntry) (domain.AuditLog, error) {
	f.entries = append(f.entries, entry)
	return domain.AuditLog{Action: entry.Action, Entity: entry.Entity}, nil
}

func (f *fakeAuditRepo) List(_ context.Context, _ domain.AuditFilter) ([]domain.AuditLog, int64, error) {
	return nil, int64(len(f.entries)), nil
}

func (f *fakeAuditRepo) last() domain.AuditEntry {
	if len(f.entries) == 0 {
		panic("fakeAuditRepo: no entries recorded")
	}
	return f.entries[len(f.entries)-1]
}

// auditVisitStore is a VisitRepository fake whose FindByID carries a visit
// code, so the visit.delete metadata path is pinned.
type auditVisitStore struct {
	stubVisitRepos
	code string
}

func (s *auditVisitStore) FindByID(_ context.Context, id domain.UUID) (domain.VisitRequest, error) {
	if !s.existing[id] {
		return domain.VisitRequest{}, domain.ErrNotFound
	}
	return domain.VisitRequest{ID: id, VisitID: s.code}, nil
}

// newAuditEngine wires the full super_admin surface with the trail attached.
func newAuditEngine(users *stubManagedUsers, locations *stubLocationAdmin, visits domain.VisitRepository, audit *fakeAuditRepo) *gin.Engine {
	engine := gin.New()
	engine.Use(withActor(domain.RoleSuperAdmin, ""))
	h := handlers.NewSuperAdminHandler(users, locations, visits, "role-admin", "role-vendor").WithAudit(audit)
	engine.POST("/locations", h.CreateLocation)
	engine.PATCH("/locations/:id", h.UpdateLocation)
	engine.DELETE("/locations/:id", h.DeleteLocation)
	engine.POST("/users", h.CreateUser)
	engine.PATCH("/users/:id/status", h.UpdateUserStatus)
	engine.PATCH("/users/:id", h.UpdateUser)
	engine.DELETE("/users/:id", h.DeleteUser)
	engine.DELETE("/visits/:id", h.DeleteVisit)
	return engine
}

func mustAuditEntry(t *testing.T, audit *fakeAuditRepo, wantAction, wantEntity string) domain.AuditEntry {
	t.Helper()
	if len(audit.entries) != 1 {
		t.Fatalf("audit entries = %d, want exactly 1 (%s)", len(audit.entries), wantAction)
	}
	entry := audit.entries[0]
	if entry.Action != wantAction || entry.Entity != wantEntity {
		t.Fatalf("entry = (%q,%q), want (%q,%q)", entry.Action, entry.Entity, wantAction, wantEntity)
	}
	if entry.ActorID == nil || *entry.ActorID != "actor-1" {
		t.Fatalf("actor = %v, want the calling super_admin", entry.ActorID)
	}
	if entry.IP == "" {
		t.Fatal("audit entry must carry the client IP")
	}
	for key, value := range entry.Metadata {
		lowered := strings.ToLower(key)
		for _, banned := range []string{"password", "token", "secret", "hash"} {
			if strings.Contains(lowered, banned) {
				t.Fatalf("audit metadata carries secret key %q", key)
			}
			if strings.Contains(strings.ToLower(value), "secret123!") {
				t.Fatalf("audit metadata leaks the password value in key %q", key)
			}
		}
	}
	return entry
}

func TestAudit_UserCreateEmitsTrail(t *testing.T) {
	users := newStubManagedUsers()
	audit := &fakeAuditRepo{}
	engine := newAuditEngine(users, newStubLocationAdmin(), newStubVisitRepos(), audit)

	rec := serveJSON(engine, "POST", "/users",
		`{"name":"Teknisi","email":"tek@vendor.local","password":"Secret123!","nik":"3578010200000001","role":"vendor"}`)
	mustStatus(t, rec, http.StatusCreated)
	entry := mustAuditEntry(t, audit, domain.AuditActionUserCreate, domain.AuditEntityUser)
	if entry.Metadata["email"] != "tek@vendor.local" || entry.Metadata["role"] != "vendor" {
		t.Fatalf("user.create metadata = %v", entry.Metadata)
	}
}

func TestAudit_UserUpdateEmitsChangedFields(t *testing.T) {
	users := newStubManagedUsers(managedAccount("target-1", "admin@thc.local", domain.RoleAdmin, nil))
	audit := &fakeAuditRepo{}
	engine := newAuditEngine(users, newStubLocationAdmin(), newStubVisitRepos(), audit)

	rec := serveJSON(engine, "PATCH", "/users/target-1", `{"name":"Nama Baru"}`)
	mustStatus(t, rec, http.StatusOK)
	entry := mustAuditEntry(t, audit, domain.AuditActionUserUpdate, domain.AuditEntityUser)
	if entry.EntityID == nil || *entry.EntityID != "target-1" {
		t.Fatalf("subject = %v, want target-1", entry.EntityID)
	}
	if entry.Metadata["fields"] != "name" {
		t.Fatalf("user.update fields = %q, want name", entry.Metadata["fields"])
	}
}

func TestAudit_UserStatusEmitsFromTo(t *testing.T) {
	users := newStubManagedUsers(managedAccount("target-1", "admin@thc.local", domain.RoleAdmin, nil))
	audit := &fakeAuditRepo{}
	engine := newAuditEngine(users, newStubLocationAdmin(), newStubVisitRepos(), audit)

	rec := serveJSON(engine, "PATCH", "/users/target-1/status", `{"status":"inactive"}`)
	mustStatus(t, rec, http.StatusOK)
	entry := mustAuditEntry(t, audit, domain.AuditActionUserStatus, domain.AuditEntityUser)
	if entry.Metadata["from"] != "active" || entry.Metadata["to"] != "inactive" {
		t.Fatalf("user.status metadata = %v, want from/to", entry.Metadata)
	}
}

func TestAudit_UserDeleteEmitsTrail(t *testing.T) {
	users := newStubManagedUsers(managedAccount("target-1", "admin@thc.local", domain.RoleAdmin, nil))
	audit := &fakeAuditRepo{}
	engine := newAuditEngine(users, newStubLocationAdmin(), newStubVisitRepos(), audit)

	rec := serve(engine, "DELETE", "/users/target-1", nil, "")
	mustStatus(t, rec, http.StatusNoContent)
	entry := mustAuditEntry(t, audit, domain.AuditActionUserDelete, domain.AuditEntityUser)
	if entry.Metadata["email"] != "admin@thc.local" || entry.Metadata["role"] != "admin" {
		t.Fatalf("user.delete metadata = %v", entry.Metadata)
	}
}

func TestAudit_LocationLifecycleEmitsTrail(t *testing.T) {
	users := newStubManagedUsers()
	locations := newStubLocationAdmin(domain.Location{ID: "loc-1", Name: "POP Lama", Type: domain.LocationPOP, Timezone: domain.TimezoneWIB, IsActive: true})
	audit := &fakeAuditRepo{}
	engine := newAuditEngine(users, locations, newStubVisitRepos(), audit)

	rec := serveJSON(engine, "POST", "/locations", `{"name":"POP Baru","type":"pop"}`)
	mustStatus(t, rec, http.StatusCreated)
	entry := mustAuditEntry(t, audit, domain.AuditActionLocationCreate, domain.AuditEntityLocation)
	if entry.Metadata["name"] != "POP Baru" || entry.Metadata["type"] != "pop" {
		t.Fatalf("location.create metadata = %v", entry.Metadata)
	}

	audit.entries = nil
	rec = serveJSON(engine, "PATCH", "/locations/loc-1", `{"name":"POP Baru Nama"}`)
	mustStatus(t, rec, http.StatusOK)
	entry = mustAuditEntry(t, audit, domain.AuditActionLocationUpdate, domain.AuditEntityLocation)
	if entry.Metadata["fields"] != "name" {
		t.Fatalf("location.update fields = %q, want name", entry.Metadata["fields"])
	}

	audit.entries = nil
	rec = serve(engine, "DELETE", "/locations/loc-1", nil, "")
	mustStatus(t, rec, http.StatusNoContent)
	entry = mustAuditEntry(t, audit, domain.AuditActionLocationDelete, domain.AuditEntityLocation)
	if entry.Metadata["name"] != "POP Baru Nama" {
		t.Fatalf("location.delete metadata = %v", entry.Metadata)
	}
}

func TestAudit_VisitDeleteEmitsTrailWithCode(t *testing.T) {
	users := newStubManagedUsers()
	visits := &auditVisitStore{stubVisitRepos: *newStubVisitRepos("visit-1"), code: "VST-0000000042"}
	audit := &fakeAuditRepo{}
	engine := newAuditEngine(users, newStubLocationAdmin(), visits, audit)

	rec := serve(engine, "DELETE", "/visits/visit-1", nil, "")
	mustStatus(t, rec, http.StatusNoContent)
	entry := mustAuditEntry(t, audit, domain.AuditActionVisitDelete, domain.AuditEntityVisit)
	if entry.EntityID == nil || *entry.EntityID != "visit-1" {
		t.Fatalf("subject = %v, want visit-1", entry.EntityID)
	}
	if entry.Metadata["visit_code"] != "VST-0000000042" {
		t.Fatalf("visit.delete metadata = %v, want the visit code", entry.Metadata)
	}
}

func TestAudit_SecurityCreateEmitsUserCreate(t *testing.T) {
	store := newStubUserStore()
	master := &stubMasterStore{locations: []domain.Location{{ID: "loc-own", Name: "Cabang Sendiri"}}}
	audit := &fakeAuditRepo{}
	engine := gin.New()
	engine.Use(withActor(domain.RoleAdmin, "loc-own"))
	h := handlers.NewUserHandler(store, master, "role-security").WithAudit(audit)
	engine.POST("/users/security", h.CreateSecurity)

	rec := serveJSON(engine, "POST", "/users/security",
		`{"name":"Pengawas Baru","email":"security@thc.local","password":"Secret123!"}`)
	mustStatus(t, rec, http.StatusCreated)
	entry := mustAuditEntry(t, audit, domain.AuditActionUserCreate, domain.AuditEntityUser)
	if entry.Metadata["role"] != "security" {
		t.Fatalf("security create role = %v", entry.Metadata)
	}
}

func TestAudit_ValidationFailureWritesNothing(t *testing.T) {
	users := newStubManagedUsers()
	audit := &fakeAuditRepo{}
	engine := newAuditEngine(users, newStubLocationAdmin(), newStubVisitRepos(), audit)

	mustStatus(t, serveJSON(engine, "POST", "/locations", `{"name":"","type":"pop"}`), http.StatusBadRequest)
	mustStatus(t, serveJSON(engine, "PATCH", "/users/missing/status", `{"status":"inactive"}`), http.StatusNotFound)
	mustStatus(t, serve(engine, "DELETE", "/visits/missing", nil, ""), http.StatusNotFound)
	if len(audit.entries) != 0 {
		t.Fatalf("rejected calls must write no trail, got %+v", audit.entries)
	}
}

func TestAudit_UserAgentTravelsToTheTrail(t *testing.T) {
	users := newStubManagedUsers(managedAccount("target-1", "admin@thc.local", domain.RoleAdmin, nil))
	audit := &fakeAuditRepo{}
	engine := gin.New()
	engine.Use(withActor(domain.RoleSuperAdmin, ""))
	h := handlers.NewSuperAdminHandler(users, newStubLocationAdmin(), newStubVisitRepos(), "role-admin", "role-vendor").WithAudit(audit)
	engine.DELETE("/users/:id", h.DeleteUser)

	req := httptest.NewRequest(http.MethodDelete, "/users/target-1", nil)
	req.Header.Set("User-Agent", "AuditAgent/9.9")
	req.RemoteAddr = "198.51.100.23:4444"
	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, req)
	mustStatus(t, rec, http.StatusNoContent)
	entry := mustAuditEntry(t, audit, domain.AuditActionUserDelete, domain.AuditEntityUser)
	if entry.UserAgent != "AuditAgent/9.9" {
		t.Fatalf("user agent = %q, want the request header", entry.UserAgent)
	}
	if entry.IP != "198.51.100.23" {
		t.Fatalf("ip = %q, want the client address", entry.IP)
	}
}

func TestAudit_StatusTransitionsEmitNothing(t *testing.T) {
	// The visit/gate lifecycle writes status_history only: no handler on this
	// surface may emit an audit row for a status move. This test pins the
	// contract by asserting the closed event set has no transition member;
	// TestAuditMVPEvents_NeverDuplicatesStatusHistory pins the vocabulary.
	for _, event := range domain.AuditMVPEvents() {
		if strings.Contains(event, "approve") || strings.Contains(event, "reject") ||
			strings.Contains(event, "checkin") || strings.Contains(event, "checkout") ||
			strings.Contains(event, "reschedule") || strings.Contains(event, "cancel") {
			t.Fatalf("audit event %q overlaps the status lifecycle", event)
		}
	}
	if len(domain.AuditMVPEvents()) != 10 {
		t.Fatalf("event set drifted: %v", domain.AuditMVPEvents())
	}
}
