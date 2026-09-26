package handlers_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"

	"thc-vms/backend/internal/delivery/http/handlers"
	"thc-vms/backend/internal/domain"
)

// stubUserStore is a hand-written fake for domain.UserRepository. ListSecurity
// filters like the real adapter: a nil scope returns every branch.
type stubUserStore struct {
	users     map[domain.UUID]domain.User
	created   []domain.User
	lastScope *domain.UUID
	findErr   error
	createErr error
	updateErr error
	updatedTo map[domain.UUID]domain.UserStatus
}

func newStubUserStore(users ...domain.User) *stubUserStore {
	s := &stubUserStore{users: map[domain.UUID]domain.User{}, updatedTo: map[domain.UUID]domain.UserStatus{}}
	for _, u := range users {
		s.users[u.ID] = u
	}
	return s
}

func (s *stubUserStore) FindByEmail(_ context.Context, email string) (domain.User, error) {
	for _, u := range s.users {
		if u.Email == email {
			return u, nil
		}
	}
	return domain.User{}, domain.ErrNotFound
}

func (s *stubUserStore) FindByID(_ context.Context, id domain.UUID) (domain.User, error) {
	if s.findErr != nil {
		return domain.User{}, s.findErr
	}
	u, ok := s.users[id]
	if !ok {
		return domain.User{}, domain.ErrNotFound
	}
	return u, nil
}

func (s *stubUserStore) Create(_ context.Context, user domain.User) (domain.User, error) {
	if s.createErr != nil {
		return domain.User{}, s.createErr
	}
	user.ID = "sec-new"
	now := time.Now()
	user.CreatedAt = now
	user.UpdatedAt = now
	s.created = append(s.created, user)
	s.users[user.ID] = user
	return user, nil
}

func (s *stubUserStore) UpdateStatus(_ context.Context, id domain.UUID, status domain.UserStatus) error {
	if s.updateErr != nil {
		return s.updateErr
	}
	if _, ok := s.users[id]; !ok {
		return domain.ErrNotFound
	}
	s.updatedTo[id] = status
	u := s.users[id]
	u.Status = status
	s.users[id] = u
	return nil
}

func (s *stubUserStore) UpdateLastLogin(_ context.Context, _ domain.UUID, _ time.Time) error {
	return nil
}

func (s *stubUserStore) ListSecurity(_ context.Context, locationID *domain.UUID) ([]domain.User, error) {
	s.lastScope = locationID
	out := []domain.User{}
	for _, u := range s.users {
		if locationID == nil || (u.LocationID != nil && *u.LocationID == *locationID) {
			out = append(out, u)
		}
	}
	return out, nil
}

// stubMasterStore is a hand-written fake for domain.MasterDataRepository.
type stubMasterStore struct {
	locations []domain.Location
	purposes  []domain.Purpose
}

func (s *stubMasterStore) ListLocations(_ context.Context, _ bool) ([]domain.Location, error) {
	return s.locations, nil
}

func (s *stubMasterStore) FindLocationByID(_ context.Context, id domain.UUID) (domain.Location, error) {
	for _, loc := range s.locations {
		if loc.ID == id {
			return loc, nil
		}
	}
	return domain.Location{}, domain.ErrNotFound
}

func (s *stubMasterStore) ListPurposes(_ context.Context, _ bool) ([]domain.Purpose, error) {
	return s.purposes, nil
}

func securityUser(id, email, loc string) domain.User {
	locationID := domain.UUID(loc)
	return domain.User{
		ID:         domain.UUID(id),
		Name:       "Satpam " + id,
		Email:      email,
		Phone:      "0811",
		RoleID:     "role-security",
		LocationID: &locationID,
		Type:       domain.UserTypeInternal,
		Status:     domain.UserStatusActive,
	}
}

func newUserEngine(users *stubUserStore, master *stubMasterStore, role domain.RoleName, loc string) *gin.Engine {
	engine := gin.New()
	engine.Use(withActor(role, loc))
	h := handlers.NewUserHandler(users, master, "role-security")
	engine.GET("/users/security", h.ListSecurity)
	engine.POST("/users/security", h.CreateSecurity)
	engine.PATCH("/users/security/:id/status", h.UpdateSecurityStatus)
	return engine
}

func TestListSecurity_AdminSeesOnlyOwnBranch(t *testing.T) {
	users := newStubUserStore(
		securityUser("sec-1", "s1@thc.local", "loc-own"),
		securityUser("sec-2", "s2@thc.local", "loc-foreign"),
	)
	master := &stubMasterStore{locations: []domain.Location{
		{ID: "loc-own", Name: "Cabang Sendiri"},
		{ID: "loc-foreign", Name: "Cabang Asing"},
	}}
	engine := newUserEngine(users, master, domain.RoleAdmin, "loc-own")

	rec := serve(engine, "GET", "/users/security", nil, "")
	mustStatus(t, rec, http.StatusOK)
	items := decodeData[[]map[string]any](t, mustSuccess(t, rec))
	if len(items) != 1 {
		t.Fatalf("admin must see 1 account, saw %d: %v", len(items), items)
	}
	if items[0]["location_id"] != "loc-own" {
		t.Fatalf("admin leaked a foreign branch: %v", items[0])
	}
	assertSubset(t, "User", items[0])
	if users.lastScope == nil || *users.lastScope != "loc-own" {
		t.Fatalf("repository scope must be the admin branch, got %v", users.lastScope)
	}
}

func TestListSecurity_SuperAdminSeesAll(t *testing.T) {
	users := newStubUserStore(
		securityUser("sec-1", "s1@thc.local", "loc-a"),
		securityUser("sec-2", "s2@thc.local", "loc-b"),
	)
	engine := newUserEngine(users, &stubMasterStore{}, domain.RoleSuperAdmin, "")

	rec := serve(engine, "GET", "/users/security", nil, "")
	mustStatus(t, rec, http.StatusOK)
	items := decodeData[[]map[string]any](t, mustSuccess(t, rec))
	if len(items) != 2 {
		t.Fatalf("super_admin must see 2 accounts, saw %d", len(items))
	}
	if users.lastScope != nil {
		t.Fatalf("super_admin scope must be nil (every branch), got %v", *users.lastScope)
	}
}

func TestCreateSecurity_AdminLocationIsForcedToOwnBranch(t *testing.T) {
	users := newStubUserStore()
	master := &stubMasterStore{locations: []domain.Location{{ID: "loc-own", Name: "Cabang Sendiri"}}}
	engine := newUserEngine(users, master, domain.RoleAdmin, "loc-own")

	body := `{"name":"Satpam Baru","email":"baru@thc.local","password":"Secret123!","location_id":"loc-foreign"}`
	rec := serveJSON(engine, "POST", "/users/security", body)
	mustStatus(t, rec, http.StatusCreated)
	if len(users.created) != 1 {
		t.Fatalf("expected 1 created account, got %d", len(users.created))
	}
	got := users.created[0]
	if got.LocationID == nil || *got.LocationID != "loc-own" {
		t.Fatalf("admin create must force its own branch, got %v", got.LocationID)
	}
	data := decodeData[map[string]any](t, mustSuccess(t, rec))
	if data["location_id"] != "loc-own" {
		t.Fatalf("response must carry the forced branch: %v", data)
	}
	assertSubset(t, "User", data)
}

func TestCreateSecurity_PasswordIsHashedNotStored(t *testing.T) {
	users := newStubUserStore()
	master := &stubMasterStore{locations: []domain.Location{{ID: "loc-own", Name: "Cabang Sendiri"}}}
	engine := newUserEngine(users, master, domain.RoleAdmin, "loc-own")

	const plaintext = "Secret123!"
	rec := serveJSON(engine, "POST", "/users/security", `{"name":"Satpam Hash","email":"hash@thc.local","password":"`+plaintext+`"}`)
	mustStatus(t, rec, http.StatusCreated)
	if len(users.created) != 1 {
		t.Fatalf("expected 1 created account, got %d", len(users.created))
	}
	stored := users.created[0].PasswordHash
	if stored == plaintext {
		t.Fatal("SECURITY: password stored in plaintext")
	}
	if stored == "" {
		t.Fatal("password hash must not be empty")
	}
	if err := bcrypt.CompareHashAndPassword([]byte(stored), []byte(plaintext)); err != nil {
		t.Fatalf("stored value is not a bcrypt hash of the password: %v", err)
	}
}

func TestUpdateUserStatus_RejectsBlacklisted(t *testing.T) {
	users := newStubUserStore(securityUser("sec-1", "s1@thc.local", "loc-own"))
	engine := newUserEngine(users, &stubMasterStore{}, domain.RoleAdmin, "loc-own")

	rec := serveJSON(engine, "PATCH", "/users/security/sec-1/status", `{"status":"blacklisted"}`)
	mustStatus(t, rec, http.StatusBadRequest)
}

func TestUpdateUserStatus_CrossBranchIsForbidden(t *testing.T) {
	users := newStubUserStore(securityUser("sec-9", "s9@thc.local", "loc-foreign"))
	engine := newUserEngine(users, &stubMasterStore{}, domain.RoleAdmin, "loc-own")

	rec := serveJSON(engine, "PATCH", "/users/security/sec-9/status", `{"status":"inactive"}`)
	mustStatus(t, rec, http.StatusForbidden)
	env := decodeEnvelope(t, rec)
	if env.Error == nil || env.Error.Message != domain.ErrForbiddenBranch.Error() {
		t.Fatalf("cross-branch refusal must carry the sentinel message, got %q", rec.Body.String())
	}
	if _, touched := users.updatedTo["sec-9"]; touched {
		t.Fatal("forbidden update must not touch the store")
	}
}

func TestUpdateUserStatus_UnknownIs404(t *testing.T) {
	users := newStubUserStore()
	engine := newUserEngine(users, &stubMasterStore{}, domain.RoleSuperAdmin, "")

	rec := serveJSON(engine, "PATCH", "/users/security/sec-ghost/status", `{"status":"inactive"}`)
	mustStatus(t, rec, http.StatusNotFound)
}
