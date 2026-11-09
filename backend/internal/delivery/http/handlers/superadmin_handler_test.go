package handlers_test

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"

	"thc-vms/backend/internal/delivery/http/handlers"
	"thc-vms/backend/internal/domain"
)

// stubManagedUsers is a hand-written fake for domain.ManagedUserRepository.
type stubManagedUsers struct {
	list       []domain.ManagedUser
	listErr    error
	lastFilter domain.UserFilter

	byID    map[domain.UUID]domain.ManagedUser
	findErr error

	created   []domain.User
	createErr error

	// updateErr forces UpdateManagedUser to fail (e.g. duplicate email via
	// the 23505 conflict mapping); must mirror the message style so the
	// handler renders the same code as production.
	updateUserErr error

	updatedTo map[domain.UUID]domain.UserStatus
	updateErr error

	// Delete-path state: reference counts per account, the deleted ids in
	// order, and an optional terminal error for the delete itself.
	visitsByVendor map[domain.UUID]int64
	staffRefs      map[domain.UUID]int64
	countErr       error
	deletedUsers   []domain.UUID
	deleteUserErr  error
}

func newStubManagedUsers(list ...domain.ManagedUser) *stubManagedUsers {
	s := &stubManagedUsers{
		byID:           map[domain.UUID]domain.ManagedUser{},
		updatedTo:      map[domain.UUID]domain.UserStatus{},
		visitsByVendor: map[domain.UUID]int64{},
		staffRefs:      map[domain.UUID]int64{},
	}
	for _, m := range list {
		s.byID[m.User.ID] = m
		s.list = append(s.list, m)
	}
	return s
}

func (s *stubManagedUsers) ListManagedUsers(_ context.Context, filter domain.UserFilter) ([]domain.ManagedUser, error) {
	s.lastFilter = filter
	if s.listErr != nil {
		return nil, s.listErr
	}
	return s.list, nil
}

func (s *stubManagedUsers) CreateManagedUser(_ context.Context, user domain.User) (domain.User, error) {
	if s.createErr != nil {
		return domain.User{}, s.createErr
	}
	user.ID = "user-new"
	now := time.Now()
	user.CreatedAt = now
	user.UpdatedAt = now
	s.created = append(s.created, user)
	s.byID[user.ID] = domain.ManagedUser{User: user}
	return user, nil
}

func (s *stubManagedUsers) FindManagedByID(_ context.Context, id domain.UUID) (domain.ManagedUser, error) {
	if s.findErr != nil {
		return domain.ManagedUser{}, s.findErr
	}
	m, ok := s.byID[id]
	if !ok {
		return domain.ManagedUser{}, domain.ErrNotFound
	}
	// The stub carries no vendor catalogue, so the display name resolves
	// from the manual override only — mirroring production for rows without
	// a vendor_id link.
	m.VendorName = nil
	if m.User.VendorNameOverride != nil && strings.TrimSpace(*m.User.VendorNameOverride) != "" {
		name := strings.TrimSpace(*m.User.VendorNameOverride)
		m.VendorName = &name
	}
	return m, nil
}

// FindByID serves the self-reset proof with the stored bcrypt hash, like the
// production adapter's UserRepository read.
func (s *stubManagedUsers) FindByID(_ context.Context, id domain.UUID) (domain.User, error) {
	m, ok := s.byID[id]
	if !ok {
		return domain.User{}, domain.ErrNotFound
	}
	return m.User, nil
}

func (s *stubManagedUsers) UpdateStatus(_ context.Context, id domain.UUID, status domain.UserStatus) error {
	if s.updateErr != nil {
		return s.updateErr
	}
	m, ok := s.byID[id]
	if !ok {
		return domain.ErrNotFound
	}
	s.updatedTo[id] = status
	m.User.Status = status
	s.byID[id] = m
	return nil
}

// UpdateManagedUser applies the patch to the stored row like the PostgreSQL
// adapter (nil members keep values). A missing id is ErrNotFound, mirroring
// the MapError pgx.ErrNoRows mapping.
func (s *stubManagedUsers) UpdateManagedUser(_ context.Context, id domain.UUID, patch domain.ManagedUserPatch) (domain.User, error) {
	if s.updateUserErr != nil {
		return domain.User{}, s.updateUserErr
	}
	m, ok := s.byID[id]
	if !ok {
		return domain.User{}, domain.ErrNotFound
	}
	if patch.Name != nil {
		m.User.Name = *patch.Name
	}
	if patch.Email != nil {
		m.User.Email = *patch.Email
	}
	if patch.Phone != nil {
		m.User.Phone = *patch.Phone
	}
	if patch.NIK != nil {
		m.User.NIK = *patch.NIK
	}
	if patch.LocationID != nil {
		m.User.LocationID = patch.LocationID
	}
	if patch.LocationIDs != nil {
		m.User.LocationIDs = append([]domain.UUID{}, patch.LocationIDs...)
	}
	if patch.VendorID != nil {
		m.User.VendorID = patch.VendorID
	}
	// Manual-company tri-state mirroring the PostgreSQL adapter: nil keeps
	// the stored override, a blank value clears it to nil, a filled value
	// sets it (trimmed, like production).
	if patch.VendorName != nil {
		if trimmed := strings.TrimSpace(*patch.VendorName); trimmed == "" {
			m.User.VendorNameOverride = nil
		} else {
			m.User.VendorNameOverride = &trimmed
		}
	}
	if patch.PasswordHash != nil {
		m.User.PasswordHash = *patch.PasswordHash
	}
	s.byID[id] = m
	return m.User, nil
}

// CountVisitsByVendorUser answers the DELETE /users/:id vendor-ownership pre-check.
func (s *stubManagedUsers) CountVisitsByVendorUser(_ context.Context, id domain.UUID) (int64, error) {
	if s.countErr != nil {
		return 0, s.countErr
	}
	return s.visitsByVendor[id], nil
}

// CountStaffReferences answers the DELETE /users/:id gate/audit pre-check.
func (s *stubManagedUsers) CountStaffReferences(_ context.Context, id domain.UUID) (int64, error) {
	if s.countErr != nil {
		return 0, s.countErr
	}
	return s.staffRefs[id], nil
}

// DeleteUser records the hard removal. A missing id is ErrNotFound, mirroring
// the MapError pgx.ErrNoRows mapping of the PostgreSQL adapter.
func (s *stubManagedUsers) DeleteUser(_ context.Context, id domain.UUID) error {
	if s.deleteUserErr != nil {
		return s.deleteUserErr
	}
	if _, ok := s.byID[id]; !ok {
		return domain.ErrNotFound
	}
	s.deletedUsers = append(s.deletedUsers, id)
	delete(s.byID, id)
	return nil
}

// stubLocationAdmin is a hand-written fake for domain.LocationAdminRepository.
// It embeds the catalogue stub so the read half is shared with the old
// master tests; only the write half is new.
type stubLocationAdmin struct {
	stubMasterStore
	created   []domain.Location
	createErr error
	updateErr error
	updatedTo map[domain.UUID]domain.LocationPatch

	// Delete-path state: reference counts per facility, the deleted ids in
	// order, and an optional terminal error for the delete itself.
	usersAt      map[domain.UUID]int64
	visitsAt     map[domain.UUID]int64
	countErr     error
	deletedLocs  []domain.UUID
	deleteLocErr error

	// Purpose-path state: the write errors, the patches applied per id, the
	// visit_purpose reference counts, and the deleted ids in order.
	purposeCreateErr error
	purposeUpdateErr error
	purposeUpdatedTo map[domain.UUID]domain.PurposePatch
	visitsAtPurpose  map[domain.UUID]int64
	purposeCountErr  error
	deletedPurposes  []domain.UUID
	deletePurposeErr error
}

func newStubLocationAdmin(locations ...domain.Location) *stubLocationAdmin {
	return &stubLocationAdmin{
		stubMasterStore:  stubMasterStore{locations: locations},
		updatedTo:        map[domain.UUID]domain.LocationPatch{},
		usersAt:          map[domain.UUID]int64{},
		visitsAt:         map[domain.UUID]int64{},
		purposeUpdatedTo: map[domain.UUID]domain.PurposePatch{},
		visitsAtPurpose:  map[domain.UUID]int64{},
	}
}

func (s *stubLocationAdmin) CreateLocation(_ context.Context, loc domain.Location) (domain.Location, error) {
	if s.createErr != nil {
		return domain.Location{}, s.createErr
	}
	loc.ID = "loc-new"
	s.created = append(s.created, loc)
	s.locations = append(s.locations, loc)
	return loc, nil
}

func (s *stubLocationAdmin) UpdateLocation(_ context.Context, id domain.UUID, patch domain.LocationPatch) (domain.Location, error) {
	if s.updateErr != nil {
		return domain.Location{}, s.updateErr
	}
	for i, loc := range s.locations {
		if loc.ID == id {
			s.updatedTo[id] = patch
			if patch.Name != nil {
				loc.Name = *patch.Name
			}
			if patch.Type != nil {
				loc.Type = *patch.Type
			}
			if patch.IsActive != nil {
				loc.IsActive = *patch.IsActive
			}
			s.locations[i] = loc
			return loc, nil
		}
	}
	return domain.Location{}, domain.ErrNotFound
}

// CountUsersByLocation answers the DELETE /locations/:id account pre-check.
func (s *stubLocationAdmin) CountUsersByLocation(_ context.Context, id domain.UUID) (int64, error) {
	if s.countErr != nil {
		return 0, s.countErr
	}
	return s.usersAt[id], nil
}

// CountVisitsByLocation answers the DELETE /locations/:id visit pre-check.
func (s *stubLocationAdmin) CountVisitsByLocation(_ context.Context, id domain.UUID) (int64, error) {
	if s.countErr != nil {
		return 0, s.countErr
	}
	return s.visitsAt[id], nil
}

// DeleteLocation records the hard removal. A missing id is ErrNotFound,
// mirroring the MapError pgx.ErrNoRows mapping of the PostgreSQL adapter.
func (s *stubLocationAdmin) DeleteLocation(_ context.Context, id domain.UUID) error {
	if s.deleteLocErr != nil {
		return s.deleteLocErr
	}
	for i, loc := range s.locations {
		if loc.ID == id {
			s.deletedLocs = append(s.deletedLocs, id)
			s.locations = append(s.locations[:i], s.locations[i+1:]...)
			return nil
		}
	}
	return domain.ErrNotFound
}

// FindPurposeByID resolves one catalogue purpose, mirroring the adapter's
// pgx.ErrNoRows mapping with ErrNotFound.
func (s *stubLocationAdmin) FindPurposeByID(_ context.Context, id domain.UUID) (domain.Purpose, error) {
	for _, purpose := range s.purposes {
		if purpose.ID == id {
			return purpose, nil
		}
	}
	return domain.Purpose{}, domain.ErrNotFound
}

// CreatePurpose stores one catalogue purpose with a synthetic id.
func (s *stubLocationAdmin) CreatePurpose(_ context.Context, purpose domain.Purpose) (domain.Purpose, error) {
	if s.purposeCreateErr != nil {
		return domain.Purpose{}, s.purposeCreateErr
	}
	purpose.ID = "pur-new"
	s.purposes = append(s.purposes, purpose)
	return purpose, nil
}

// UpdatePurpose applies the patch onto the stored row. A missing id is
// ErrNotFound, mirroring the adapter.
func (s *stubLocationAdmin) UpdatePurpose(_ context.Context, id domain.UUID, patch domain.PurposePatch) (domain.Purpose, error) {
	if s.purposeUpdateErr != nil {
		return domain.Purpose{}, s.purposeUpdateErr
	}
	for i, purpose := range s.purposes {
		if purpose.ID == id {
			s.purposeUpdatedTo[id] = patch
			if patch.Name != nil {
				purpose.Name = *patch.Name
			}
			if patch.IsActive != nil {
				purpose.IsActive = *patch.IsActive
			}
			s.purposes[i] = purpose
			return purpose, nil
		}
	}
	return domain.Purpose{}, domain.ErrNotFound
}

// CountVisitsByPurpose answers the DELETE /purposes/:id pre-check.
func (s *stubLocationAdmin) CountVisitsByPurpose(_ context.Context, id domain.UUID) (int64, error) {
	if s.purposeCountErr != nil {
		return 0, s.purposeCountErr
	}
	return s.visitsAtPurpose[id], nil
}

// DeletePurpose records the hard removal. A missing id is ErrNotFound,
// mirroring the MapError pgx.ErrNoRows mapping of the PostgreSQL adapter.
func (s *stubLocationAdmin) DeletePurpose(_ context.Context, id domain.UUID) error {
	if s.deletePurposeErr != nil {
		return s.deletePurposeErr
	}
	for i, purpose := range s.purposes {
		if purpose.ID == id {
			s.deletedPurposes = append(s.deletedPurposes, id)
			s.purposes = append(s.purposes[:i], s.purposes[i+1:]...)
			return nil
		}
	}
	return domain.ErrNotFound
}

func managedAccount(id, email string, role domain.RoleName, loc *string) domain.ManagedUser {
	var locationID *domain.UUID
	if loc != nil {
		parsed := domain.UUID(*loc)
		locationID = &parsed
	}
	accountType := domain.UserTypeInternal
	if role == domain.RoleVendor {
		accountType = domain.UserTypeExternal
	}
	return domain.ManagedUser{
		User: domain.User{
			ID: domain.UUID(id), Name: "Akun " + id, Email: email, Phone: "0811",
			RoleID: "role-" + domain.UUID(role), LocationID: locationID,
			Type: accountType, Status: domain.UserStatusActive,
		},
		Role: role,
	}
}

func newSuperAdminEngine(users *stubManagedUsers, locations *stubLocationAdmin, role domain.RoleName) *gin.Engine {
	engine := gin.New()
	engine.Use(withActor(role, ""))
	h := handlers.NewSuperAdminHandler(users, locations, locations, newStubVisitRepos(), "role-admin", "role-vendor")
	engine.POST("/locations", h.CreateLocation)
	engine.PATCH("/locations/:id", h.UpdateLocation)
	engine.DELETE("/locations/:id", h.DeleteLocation)
	engine.POST("/purposes", h.CreatePurpose)
	engine.PATCH("/purposes/:id", h.UpdatePurpose)
	engine.DELETE("/purposes/:id", h.DeletePurpose)
	engine.GET("/users", h.ListUsers)
	engine.POST("/users", h.CreateUser)
	engine.PATCH("/users/:id/status", h.UpdateUserStatus)
	engine.PATCH("/users/:id", h.UpdateUser)
	engine.DELETE("/users/:id", h.DeleteUser)
	engine.DELETE("/visits/:id", h.DeleteVisit)
	return engine
}

func TestSuperAdmin_NonSuperAdminIsForbidden(t *testing.T) {
	users := newStubManagedUsers()
	locations := newStubLocationAdmin()
	engine := newSuperAdminEngine(users, locations, domain.RoleAdmin)

	calls := []struct{ method, path, body string }{
		{"POST", "/locations", `{"name":"X","type":"cabang"}`},
		{"PATCH", "/locations/loc-1", `{"name":"Y"}`},
		{"POST", "/purposes", `{"name":"X"}`},
		{"PATCH", "/purposes/pur-1", `{"name":"Y"}`},
		{"GET", "/users", ""},
		// POST /users intentionally absent: since PRD §4.1 it is conditionally
		// open (admin+vendor → 201 with a custom message on refusal, not the
		// sentinel). TestSuperAdmin_AdminMayRegisterVendorOnly pins that matrix.
		{"PATCH", "/users/some-id/status", `{"status":"inactive"}`},
		{"PATCH", "/users/some-id", `{"name":"X"}`},
		// Approval (activate) and rejection (delete) stay superadmin-only:
		// a branch admin can register vendors via POST /users but can never
		// flip their status or remove them.
		{"DELETE", "/users/some-id", ""},
	}
	for _, tc := range calls {
		resp := serveJSON(engine, tc.method, tc.path, tc.body)
		mustStatus(t, resp, http.StatusForbidden)
		env := decodeEnvelope(t, resp)
		if env.Error == nil || env.Error.Message != domain.ErrForbiddenBranch.Error() {
			t.Fatalf("%s %s: refusal must carry the sentinel message, got %q", tc.method, tc.path, resp.Body.String())
		}
	}
	if len(locations.created) != 0 || len(users.created) != 0 || len(users.updatedTo) != 0 {
		t.Fatal("forbidden calls must not touch any store")
	}
}

func TestSuperAdmin_CreateLocation(t *testing.T) {
	t.Run("201 with timezone default", func(t *testing.T) {
		locations := newStubLocationAdmin()
		engine := newSuperAdminEngine(newStubManagedUsers(), locations, domain.RoleSuperAdmin)

		rec := serveJSON(engine, "POST", "/locations", `{"name":"POP Baru","type":"pop","city":"Malang"}`)
		mustStatus(t, rec, http.StatusCreated)
		data := decodeData[map[string]any](t, mustSuccess(t, rec))
		assertSubset(t, "Location", data)
		if data["timezone"] != "WIB" {
			t.Fatalf("timezone must default to WIB, got %v", data)
		}
		if data["is_active"] != true {
			t.Fatalf("new facility must carry is_active=true, got %v", data)
		}
		if len(locations.created) != 1 || locations.created[0].Type != domain.LocationPOP {
			t.Fatalf("store must hold the pop row, got %+v", locations.created)
		}
	})

	t.Run("400 on blank name, bad type and bad timezone", func(t *testing.T) {
		locations := newStubLocationAdmin()
		engine := newSuperAdminEngine(newStubManagedUsers(), locations, domain.RoleSuperAdmin)

		for _, body := range []string{
			`{"name":"","type":"cabang"}`,
			`{"name":"X","type":"head_office"}`,
			`{"name":"X","type":"cabang","timezone":"EST"}`,
			`{"name":"X"}`,
		} {
			if rec := serveJSON(engine, "POST", "/locations", body); rec.Code != http.StatusBadRequest {
				t.Fatalf("body %s: status = %d, want 400: %q", body, rec.Code, rec.Body.String())
			}
		}
		if len(locations.created) != 0 {
			t.Fatal("rejected creates must not touch the store")
		}
	})

	t.Run("409 on duplicate Kantor Pusat", func(t *testing.T) {
		locations := newStubLocationAdmin()
		locations.createErr = domain.Conflict("Kantor Pusat sudah terdaftar. Hanya boleh ada satu Kantor Pusat.")
		engine := newSuperAdminEngine(newStubManagedUsers(), locations, domain.RoleSuperAdmin)

		rec := serveJSON(engine, "POST", "/locations", `{"name":"Kantor Pusat Kedua","type":"pusat"}`)
		mustStatus(t, rec, http.StatusConflict)
		env := decodeEnvelope(t, rec)
		if env.Error == nil || env.Error.Code != "CONFLICT" {
			t.Fatalf("duplicate pusat must be 409 CONFLICT, got %q", rec.Body.String())
		}
	})
}

func TestSuperAdmin_UpdateLocation(t *testing.T) {
	t.Run("200 partial patch", func(t *testing.T) {
		locations := newStubLocationAdmin(domain.Location{
			ID: "loc-1", Name: "Cabang Lama", Type: domain.LocationCabang,
			Timezone: domain.TimezoneWIB, IsActive: true,
		})
		engine := newSuperAdminEngine(newStubManagedUsers(), locations, domain.RoleSuperAdmin)

		rec := serveJSON(engine, "PATCH", "/locations/loc-1", `{"name":"Cabang Baru"}`)
		mustStatus(t, rec, http.StatusOK)
		data := decodeData[map[string]any](t, mustSuccess(t, rec))
		assertSubset(t, "Location", data)
		if data["name"] != "Cabang Baru" {
			t.Fatalf("name must be patched, got %v", data)
		}
		if data["is_active"] != true {
			t.Fatalf("patched row must carry is_active=true, got %v", data)
		}
	})

	t.Run("200 deactivation flips the flag", func(t *testing.T) {
		locations := newStubLocationAdmin(domain.Location{
			ID: "loc-1", Name: "Cabang Lama", Type: domain.LocationCabang,
			Timezone: domain.TimezoneWIB, IsActive: true,
		})
		engine := newSuperAdminEngine(newStubManagedUsers(), locations, domain.RoleSuperAdmin)

		rec := serveJSON(engine, "PATCH", "/locations/loc-1", `{"is_active":false}`)
		mustStatus(t, rec, http.StatusOK)
		data := decodeData[map[string]any](t, mustSuccess(t, rec))
		assertSubset(t, "Location", data)
		if data["is_active"] != false {
			t.Fatalf("deactivation must carry is_active=false, got %v", data)
		}
	})

	t.Run("404 unknown id and 400 empty patch", func(t *testing.T) {
		locations := newStubLocationAdmin()
		engine := newSuperAdminEngine(newStubManagedUsers(), locations, domain.RoleSuperAdmin)

		mustStatus(t, serveJSON(engine, "PATCH", "/locations/loc-ghost", `{"name":"X"}`), http.StatusNotFound)
		mustStatus(t, serveJSON(engine, "PATCH", "/locations/loc-ghost", `{}`), http.StatusBadRequest)
	})
}

func TestSuperAdmin_ListUsers(t *testing.T) {
	locA := "11111111-1111-1111-1111-111111111111"
	users := newStubManagedUsers(
		managedAccount("u-1", "admin@thc.local", domain.RoleAdmin, &locA),
		managedAccount("u-2", "teknisi@vendor.local", domain.RoleVendor, nil),
	)
	engine := newSuperAdminEngine(users, newStubLocationAdmin(), domain.RoleSuperAdmin)

	rec := serve(engine, "GET", "/users", nil, "")
	mustStatus(t, rec, http.StatusOK)
	items := decodeData[[]map[string]any](t, mustSuccess(t, rec))
	if len(items) != 2 {
		t.Fatalf("expected 2 accounts, got %d", len(items))
	}
	for _, item := range items {
		assertSubset(t, "User", item)
	}

	rec = serve(engine, "GET", "/users?role=admin&search=admin&location_id="+locA, nil, "")
	mustStatus(t, rec, http.StatusOK)
	if users.lastFilter.Role == nil || *users.lastFilter.Role != domain.RoleAdmin {
		t.Fatalf("role filter must reach the store, got %+v", users.lastFilter)
	}
	if users.lastFilter.Search != "admin" {
		t.Fatalf("search must reach the store, got %q", users.lastFilter.Search)
	}
	if users.lastFilter.LocationID == nil || *users.lastFilter.LocationID != domain.UUID(locA) {
		t.Fatalf("location filter must reach the store, got %+v", users.lastFilter.LocationID)
	}

	mustStatus(t, serve(engine, "GET", "/users?role=owner", nil, ""), http.StatusBadRequest)
	mustStatus(t, serve(engine, "GET", "/users?location_id=bukan-uuid", nil, ""), http.StatusBadRequest)
}

func TestSuperAdmin_CreateUser(t *testing.T) {
	const locID = "11111111-1111-1111-1111-111111111111"

	t.Run("201 admin is internal with branch", func(t *testing.T) {
		users := newStubManagedUsers()
		locations := newStubLocationAdmin(domain.Location{ID: domain.UUID(locID), Name: "Cabang A"})
		engine := newSuperAdminEngine(users, locations, domain.RoleSuperAdmin)

		body := `{"name":"Admin Baru","email":"baru@thc.local","password":"Secret123!","nik":"3578010100000001","role":"admin","location_id":"` + locID + `"}`
		rec := serveJSON(engine, "POST", "/users", body)
		mustStatus(t, rec, http.StatusCreated)
		data := decodeData[map[string]any](t, mustSuccess(t, rec))
		assertSubset(t, "User", data)
		if data["role"] != "admin" || data["type"] != "internal" || data["location_id"] != locID {
			t.Fatalf("admin projection wrong: %v", data)
		}
		if data["location_name"] != "Cabang A" {
			t.Fatalf("location_name must resolve, got %v", data)
		}
		if len(users.created) != 1 {
			t.Fatalf("expected 1 created account, got %d", len(users.created))
		}
		got := users.created[0]
		if got.RoleID != "role-admin" || got.Type != domain.UserTypeInternal {
			t.Fatalf("stored row wrong: %+v", got)
		}
		if err := bcrypt.CompareHashAndPassword([]byte(got.PasswordHash), []byte("Secret123!")); err != nil {
			t.Fatalf("password must be bcrypt-hashed: %v", err)
		}
	})

	t.Run("201 vendor is external without branch", func(t *testing.T) {
		users := newStubManagedUsers()
		engine := newSuperAdminEngine(users, newStubLocationAdmin(), domain.RoleSuperAdmin)

		body := `{"name":"Teknisi","email":"tek@vendor.local","password":"Secret123!","nik":"3578010200000001","role":"vendor"}`
		rec := serveJSON(engine, "POST", "/users", body)
		mustStatus(t, rec, http.StatusCreated)
		data := decodeData[map[string]any](t, mustSuccess(t, rec))
		if data["type"] != "external" || data["location_id"] != nil {
			t.Fatalf("vendor projection wrong: %v", data)
		}
		if len(users.created) != 1 || users.created[0].RoleID != "role-vendor" {
			t.Fatalf("stored vendor row wrong: %+v", users.created)
		}
	})

	t.Run("400 and 409 matrix", func(t *testing.T) {
		users := newStubManagedUsers()
		users.createErr = fmt.Errorf("repository: uniqueness clash: %w", domain.ErrConflict)
		engine := newSuperAdminEngine(users, newStubLocationAdmin(), domain.RoleSuperAdmin)

		bad := []string{
			`{"name":"","email":"a@thc.local","password":"Secret123!","role":"admin","location_id":"` + locID + `"}`,
			`{"name":"A","email":"a@thc.local","password":"Secret123!","role":"admin"}`,
			`{"name":"A","email":"a@thc.local","password":"Secret123!","role":"vendor","location_id":"` + locID + `"}`,
			`{"name":"A","email":"a@thc.local","password":"Secret123!","role":"security","location_id":"` + locID + `"}`,
			`{"name":"A","email":"a@thc.local","password":"Secret123!","role":"super_admin"}`,
			`{"name":"A","email":"a@thc.local","password":"Secret123!","role":"owner"}`,
		}
		for _, body := range bad {
			if rec := serveJSON(engine, "POST", "/users", body); rec.Code != http.StatusBadRequest {
				t.Fatalf("body %s: status = %d, want 400: %q", body, rec.Code, rec.Body.String())
			}
		}

		dup := `{"name":"Kembar","email":"dup@thc.local","password":"Secret123!","nik":"3578010200000001","role":"vendor"}`
		rec := serveJSON(engine, "POST", "/users", dup)
		mustStatus(t, rec, http.StatusConflict)
		env := decodeEnvelope(t, rec)
		if env.Error == nil || env.Error.Code != "CONFLICT" {
			t.Fatalf("duplicate email must be 409 CONFLICT, got %q", rec.Body.String())
		}
	})
}

// TestSuperAdmin_AdminMayRegisterVendorOnly pins PRD §4.1: branch admins may
// register vendor accounts (their operational need) but nothing else;
// other roles stay 403 via the handler gate.
func TestSuperAdmin_AdminMayRegisterVendorOnly(t *testing.T) {
	users := newStubManagedUsers()
	engine := newSuperAdminEngine(users, newStubLocationAdmin(), domain.RoleAdmin)

	rec := serveJSON(engine, "POST", "/users", `{"name":"Teknisi Baru","email":"baru@vendor.local","password":"Secret123!","role":"vendor","nik":"3578010200000001"}`)
	mustStatus(t, rec, http.StatusCreated)
	data := decodeData[map[string]any](t, mustSuccess(t, rec))
	assertSubset(t, "User", data)
	if data["role"] != "vendor" || data["type"] != "external" {
		t.Fatalf("admin-created account must be external vendor: %v", data)
	}
	if data["nik"] != "3578010200000001" {
		t.Fatalf("nik must round-trip, got %v", data["nik"])
	}

	rec = serveJSON(engine, "POST", "/users", `{"name":"A","email":"a@thc.local","password":"Secret123!","role":"admin","nik":"3578010100000001"}`)
	mustStatus(t, rec, http.StatusForbidden)
	if env := decodeEnvelope(t, rec); env.Error == nil || env.Error.Message == "" {
		t.Fatalf("admin-creating-admin refusal must carry a message, got %q", rec.Body.String())
	}

	vendorEngine := newSuperAdminEngine(newStubManagedUsers(), newStubLocationAdmin(), domain.RoleVendor)
	mustStatus(t, serveJSON(vendorEngine, "POST", "/users", `{"name":"P","email":"p@vendor.local","password":"Secret123!","role":"vendor","nik":"3578010200000001"}`), http.StatusForbidden)
}

func TestSuperAdmin_UpdateUserStatus(t *testing.T) {
	t.Run("200 flips another admin", func(t *testing.T) {
		users := newStubManagedUsers(managedAccount("target-1", "admin@thc.local", domain.RoleAdmin, nil))
		engine := newSuperAdminEngine(users, newStubLocationAdmin(), domain.RoleSuperAdmin)

		rec := serveJSON(engine, "PATCH", "/users/target-1/status", `{"status":"inactive"}`)
		mustStatus(t, rec, http.StatusOK)
		data := decodeData[map[string]any](t, mustSuccess(t, rec))
		assertSubset(t, "User", data)
		if data["status"] != "inactive" {
			t.Fatalf("status must flip, got %v", data)
		}
	})

	t.Run("200 approves a pending self-registration", func(t *testing.T) {
		target := managedAccount("target-2", "vendor@vendor.example", domain.RoleVendor, nil)
		target.User.Status = domain.UserStatusPending
		users := newStubManagedUsers(target)
		engine := newSuperAdminEngine(users, newStubLocationAdmin(), domain.RoleSuperAdmin)

		rec := serveJSON(engine, "PATCH", "/users/target-2/status", `{"status":"active"}`)
		mustStatus(t, rec, http.StatusOK)
		data := decodeData[map[string]any](t, mustSuccess(t, rec))
		if data["status"] != "active" {
			t.Fatalf("pending approval must flip to active, got %v", data)
		}
	})

	t.Run("403 self, 403 other super_admin, 404 ghost, 400 vocabulary", func(t *testing.T) {
		users := newStubManagedUsers(
			managedAccount("actor-1", "saya@thc.local", domain.RoleSuperAdmin, nil),
			managedAccount("target-9", "pusat@thc.local", domain.RoleSuperAdmin, nil),
		)
		engine := newSuperAdminEngine(users, newStubLocationAdmin(), domain.RoleSuperAdmin)

		rec := serveJSON(engine, "PATCH", "/users/actor-1/status", `{"status":"inactive"}`)
		mustStatus(t, rec, http.StatusForbidden)
		if env := decodeEnvelope(t, rec); env.Error == nil || env.Error.Message == "" {
			t.Fatalf("self-change refusal must carry a message, got %q", rec.Body.String())
		}

		rec = serveJSON(engine, "PATCH", "/users/target-9/status", `{"status":"inactive"}`)
		mustStatus(t, rec, http.StatusForbidden)

		mustStatus(t, serveJSON(engine, "PATCH", "/users/ghost/status", `{"status":"inactive"}`), http.StatusNotFound)

		users2 := newStubManagedUsers(managedAccount("target-1", "admin@thc.local", domain.RoleAdmin, nil))
		engine2 := newSuperAdminEngine(users2, newStubLocationAdmin(), domain.RoleSuperAdmin)
		mustStatus(t, serveJSON(engine2, "PATCH", "/users/target-1/status", `{"status":"blacklisted"}`), http.StatusBadRequest)

		if len(users.updatedTo) != 0 || len(users2.updatedTo) != 0 {
			t.Fatal("refused flips must not touch the store")
		}
	})
}
