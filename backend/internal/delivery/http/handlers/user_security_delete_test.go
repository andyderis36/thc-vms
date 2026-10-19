package handlers_test

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/handlers"
	"thc-vms/backend/internal/domain"
)

// stubSecurityDeleteStore is a hand-written fake for domain.UserRepository
// PLUS the delete half of the account port (the same three methods
// domain.ManagedUserRepository carries for DELETE /users/:id). It is a NEW
// type on purpose: the older stubUserStore implements only
// domain.UserRepository and must keep compiling unchanged.
type stubSecurityDeleteStore struct {
	users map[domain.UUID]domain.User

	visitsByVendor map[domain.UUID]int64
	staffRefs      map[domain.UUID]int64
	countErr       error

	deleted   []domain.UUID
	deleteErr error
}

func newStubSecurityDeleteStore(users ...domain.User) *stubSecurityDeleteStore {
	s := &stubSecurityDeleteStore{
		users:          map[domain.UUID]domain.User{},
		visitsByVendor: map[domain.UUID]int64{},
		staffRefs:      map[domain.UUID]int64{},
	}
	for _, u := range users {
		s.users[u.ID] = u
	}
	return s
}

func (s *stubSecurityDeleteStore) FindByEmail(_ context.Context, email string) (domain.User, error) {
	for _, u := range s.users {
		if u.Email == email {
			return u, nil
		}
	}
	return domain.User{}, domain.ErrNotFound
}

func (s *stubSecurityDeleteStore) FindByID(_ context.Context, id domain.UUID) (domain.User, error) {
	u, ok := s.users[id]
	if !ok {
		return domain.User{}, domain.ErrNotFound
	}
	return u, nil
}

func (s *stubSecurityDeleteStore) Create(_ context.Context, user domain.User) (domain.User, error) {
	user.ID = "sec-new"
	now := time.Now()
	user.CreatedAt = now
	user.UpdatedAt = now
	s.users[user.ID] = user
	return user, nil
}

func (s *stubSecurityDeleteStore) UpdateStatus(_ context.Context, id domain.UUID, status domain.UserStatus) error {
	u, ok := s.users[id]
	if !ok {
		return domain.ErrNotFound
	}
	u.Status = status
	s.users[id] = u
	return nil
}

func (s *stubSecurityDeleteStore) UpdateLastLogin(_ context.Context, _ domain.UUID, _ time.Time) error {
	return nil
}

func (s *stubSecurityDeleteStore) ListSecurity(_ context.Context, locationID *domain.UUID) ([]domain.User, error) {
	out := []domain.User{}
	for _, u := range s.users {
		if locationID == nil || (u.LocationID != nil && *u.LocationID == *locationID) {
			out = append(out, u)
		}
	}
	return out, nil
}

// CountVisitsByVendorUser answers the vendor-ownership pre-check, mirroring the
// super_admin fake: a non-zero count blocks the delete with 409.
func (s *stubSecurityDeleteStore) CountVisitsByVendorUser(_ context.Context, id domain.UUID) (int64, error) {
	if s.countErr != nil {
		return 0, s.countErr
	}
	return s.visitsByVendor[id], nil
}

// CountStaffReferences answers the gate/audit pre-check the same way.
func (s *stubSecurityDeleteStore) CountStaffReferences(_ context.Context, id domain.UUID) (int64, error) {
	if s.countErr != nil {
		return 0, s.countErr
	}
	return s.staffRefs[id], nil
}

// UpdateManagedUser applies the patch to the stored row like the PostgreSQL
// adapter (nil members keep values). A missing id is ErrNotFound.
func (s *stubSecurityDeleteStore) UpdateManagedUser(_ context.Context, id domain.UUID, patch domain.ManagedUserPatch) (domain.User, error) {
	u, ok := s.users[id]
	if !ok {
		return domain.User{}, domain.ErrNotFound
	}
	if patch.Name != nil {
		u.Name = *patch.Name
	}
	if patch.Email != nil {
		u.Email = *patch.Email
	}
	if patch.Phone != nil {
		u.Phone = *patch.Phone
	}
	if patch.LocationID != nil {
		u.LocationID = patch.LocationID
	}
	if patch.VendorID != nil {
		u.VendorID = patch.VendorID
	}
	if patch.PasswordHash != nil {
		u.PasswordHash = *patch.PasswordHash
	}
	s.users[id] = u
	return u, nil
}

// DeleteUser records the hard removal. A missing id is ErrNotFound,
// mirroring the MapError pgx.ErrNoRows mapping of the PostgreSQL adapter.
func (s *stubSecurityDeleteStore) DeleteUser(_ context.Context, id domain.UUID) error {
	if s.deleteErr != nil {
		return s.deleteErr
	}
	if _, ok := s.users[id]; !ok {
		return domain.ErrNotFound
	}
	s.deleted = append(s.deleted, id)
	delete(s.users, id)
	return nil
}

// nonSecurityUser is an account of another role stationed at loc: touching it
// through the security path must 404, never 403, so the security route can
// neither leak nor collide with DELETE /users/:id.
func nonSecurityUser(id, email, loc string) domain.User {
	u := securityUser(id, email, loc)
	u.RoleID = "role-admin"
	return u
}

func newSecurityDeleteEngine(store *stubSecurityDeleteStore, role domain.RoleName, loc string) *gin.Engine {
	engine := gin.New()
	engine.Use(withActor(role, loc))
	h := handlers.NewUserHandler(store, &stubMasterStore{}, "role-security")
	engine.DELETE("/users/security/:id", h.DeleteSecurity)
	engine.PATCH("/users/security/:id", h.UpdateSecurity)
	return engine
}

func TestDeleteSecurity_AdminRemovesOwnBranchWith204(t *testing.T) {
	store := newStubSecurityDeleteStore(securityUser("sec-1", "s1@thc.local", "loc-own"))
	engine := newSecurityDeleteEngine(store, domain.RoleAdmin, "loc-own")

	rec := serve(engine, "DELETE", "/users/security/sec-1", nil, "")
	mustStatus(t, rec, http.StatusNoContent)
	if rec.Body.Len() != 0 {
		t.Fatalf("204 must carry no body, got %q", rec.Body.String())
	}
	if len(store.deleted) != 1 || store.deleted[0] != "sec-1" {
		t.Fatalf("store must hold the deletion, got %+v", store.deleted)
	}
}

func TestDeleteSecurity_SuperAdminRemovesAnyBranch(t *testing.T) {
	store := newStubSecurityDeleteStore(securityUser("sec-2", "s2@thc.local", "loc-foreign"))
	engine := newSecurityDeleteEngine(store, domain.RoleSuperAdmin, "")

	rec := serve(engine, "DELETE", "/users/security/sec-2", nil, "")
	mustStatus(t, rec, http.StatusNoContent)
	if rec.Body.Len() != 0 {
		t.Fatalf("204 must carry no body, got %q", rec.Body.String())
	}
	if len(store.deleted) != 1 || store.deleted[0] != "sec-2" {
		t.Fatalf("store must hold the deletion, got %+v", store.deleted)
	}
}

func TestDeleteSecurity_CrossBranchIs403(t *testing.T) {
	store := newStubSecurityDeleteStore(securityUser("sec-9", "s9@thc.local", "loc-foreign"))
	engine := newSecurityDeleteEngine(store, domain.RoleAdmin, "loc-own")

	rec := serve(engine, "DELETE", "/users/security/sec-9", nil, "")
	mustStatus(t, rec, http.StatusForbidden)
	env := decodeEnvelope(t, rec)
	if env.Error == nil || env.Error.Code != "FORBIDDEN_BRANCH" || env.Error.Message == "" {
		t.Fatalf("cross-branch refusal must be 403 FORBIDDEN_BRANCH with a message, got %q", rec.Body.String())
	}
	if len(store.deleted) != 0 {
		t.Fatal("refused delete must not touch the store")
	}
}

func TestDeleteSecurity_UnknownIs404(t *testing.T) {
	store := newStubSecurityDeleteStore()
	engine := newSecurityDeleteEngine(store, domain.RoleAdmin, "loc-own")

	rec := serve(engine, "DELETE", "/users/security/sec-ghost", nil, "")
	mustStatus(t, rec, http.StatusNotFound)
	env := decodeEnvelope(t, rec)
	if env.Error == nil || env.Error.Code != "NOT_FOUND" || env.Error.Message != "Akun security tidak ditemukan." {
		t.Fatalf("unknown id must be the Akun security 404, got %q", rec.Body.String())
	}
}

func TestDeleteSecurity_NonSecurityTargetIs404(t *testing.T) {
	for _, role := range []domain.RoleName{domain.RoleAdmin, domain.RoleSuperAdmin} {
		loc := "loc-own"
		if role == domain.RoleSuperAdmin {
			loc = ""
		}
		store := newStubSecurityDeleteStore(nonSecurityUser("adm-1", "admin@thc.local", "loc-own"))
		engine := newSecurityDeleteEngine(store, role, loc)

		rec := serve(engine, "DELETE", "/users/security/adm-1", nil, "")
		mustStatus(t, rec, http.StatusNotFound)
		env := decodeEnvelope(t, rec)
		if env.Error == nil || env.Error.Code != "NOT_FOUND" || env.Error.Message != "Akun security tidak ditemukan." {
			t.Fatalf("role %s: non-security target must be the Akun security 404, got %q", role, rec.Body.String())
		}
		if len(store.deleted) != 0 {
			t.Fatal("refused delete must not touch the store")
		}
	}
}

func TestDeleteSecurity_ReferencedIs409(t *testing.T) {
	t.Run("staff named on gate or audit rows", func(t *testing.T) {
		store := newStubSecurityDeleteStore(securityUser("sec-1", "s1@thc.local", "loc-own"))
		store.staffRefs["sec-1"] = 3
		engine := newSecurityDeleteEngine(store, domain.RoleAdmin, "loc-own")

		rec := serve(engine, "DELETE", "/users/security/sec-1", nil, "")
		mustStatus(t, rec, http.StatusConflict)
		env := decodeEnvelope(t, rec)
		if env.Error == nil || env.Error.Code != "CONFLICT" || env.Error.Message == "" {
			t.Fatalf("staff references must be 409 CONFLICT, got %q", rec.Body.String())
		}
		if len(store.deleted) != 0 {
			t.Fatal("refused delete must not touch the store")
		}
	})

	t.Run("visits still owned as vendor", func(t *testing.T) {
		store := newStubSecurityDeleteStore(securityUser("sec-1", "s1@thc.local", "loc-own"))
		store.visitsByVendor["sec-1"] = 2
		engine := newSecurityDeleteEngine(store, domain.RoleAdmin, "loc-own")

		rec := serve(engine, "DELETE", "/users/security/sec-1", nil, "")
		mustStatus(t, rec, http.StatusConflict)
		env := decodeEnvelope(t, rec)
		if env.Error == nil || env.Error.Code != "CONFLICT" || env.Error.Message == "" {
			t.Fatalf("owned visits must be 409 CONFLICT, got %q", rec.Body.String())
		}
		if len(store.deleted) != 0 {
			t.Fatal("refused delete must not touch the store")
		}
	})

	t.Run("reference racing the pre-check maps to 409", func(t *testing.T) {
		store := newStubSecurityDeleteStore(securityUser("sec-1", "s1@thc.local", "loc-own"))
		store.deleteErr = fmt.Errorf("repository: foreign key rejected reference: %w", domain.ErrConflict)
		engine := newSecurityDeleteEngine(store, domain.RoleAdmin, "loc-own")

		rec := serve(engine, "DELETE", "/users/security/sec-1", nil, "")
		mustStatus(t, rec, http.StatusConflict)
	})
}

func TestDeleteSecurity_WrongRoleIs403(t *testing.T) {
	for _, role := range []domain.RoleName{domain.RoleSecurity, domain.RoleVendor} {
		store := newStubSecurityDeleteStore(securityUser("sec-1", "s1@thc.local", "loc-own"))
		engine := newSecurityDeleteEngine(store, role, "loc-own")

		rec := serve(engine, "DELETE", "/users/security/sec-1", nil, "")
		mustStatus(t, rec, http.StatusForbidden)
		if len(store.deleted) != 0 {
			t.Fatalf("role %s: refused delete must not touch the store", role)
		}
	}
}

func TestUpdateSecurityStatus_NonSecurityTargetIs404(t *testing.T) {
	// Locks the branch-account isolation fix on the pre-existing status path:
	// an admin must not flip another role's account through the security
	// endpoint (that bypassed the super_admin-only guard of PATCH
	// /users/:id/status); it now answers 404 like an unknown security id.
	store := newStubUserStore(nonSecurityUser("adm-1", "admin@thc.local", "loc-own"))
	engine := newUserEngine(store, &stubMasterStore{}, domain.RoleAdmin, "loc-own")

	rec := serveJSON(engine, "PATCH", "/users/security/adm-1/status", `{"status":"inactive"}`)
	mustStatus(t, rec, http.StatusNotFound)
	env := decodeEnvelope(t, rec)
	if env.Error == nil || env.Error.Code != "NOT_FOUND" || env.Error.Message != "Akun security tidak ditemukan." {
		t.Fatalf("non-security target must be the Akun security 404, got %q", rec.Body.String())
	}
	if _, touched := store.updatedTo["adm-1"]; touched {
		t.Fatal("refused update must not touch the store")
	}
}
