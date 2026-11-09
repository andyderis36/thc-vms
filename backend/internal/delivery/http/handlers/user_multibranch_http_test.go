package handlers_test

import (
	"net/http"
	"testing"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/handlers"
	"thc-vms/backend/internal/domain"
)

// RED seam suite: POST/PATCH managed-user + security create/move must thread
// location_ids[] from the body through validation into an atomic dual-write
// of the FULL union, and echo both keys. Every test below fails while the
// handlers drop the member (the sole reader is the scope stash).

const multibranchGhostUUID = "44444444-4444-4444-8444-444444444444"

// multibranchCatalogue carries three known branches for the pre-check.
func multibranchCatalogue() *stubLocationAdmin {
	return newStubLocationAdmin(
		domain.Location{ID: domain.UUID(branchAUUID), Name: "Kantor Cabang A"},
		domain.Location{ID: domain.UUID(branchBUUID), Name: "Kantor Cabang B"},
	)
}

// mustLocationIDs asserts the account JSON echoes the exact union in order.
func mustLocationIDs(t *testing.T, data map[string]any, want ...string) {
	t.Helper()
	raw, ok := data["location_ids"]
	if !ok {
		t.Fatalf("response must echo location_ids, got %v", data)
	}
	items, ok := raw.([]any)
	if !ok {
		t.Fatalf("location_ids must be an array, got %T (%v)", raw, raw)
	}
	if len(items) != len(want) {
		t.Fatalf("location_ids = %v, want %v", raw, want)
	}
	for i, w := range want {
		if items[i] != w {
			t.Fatalf("location_ids = %v, want %v", raw, want)
		}
	}
}

// mustStoreUnion asserts the stub received the FULL union on the write.
func mustStoreUnion(t *testing.T, got []domain.UUID, want ...string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("stored union = %v, want %v", got, want)
	}
	for i, w := range want {
		if string(got[i]) != w {
			t.Fatalf("stored union = %v, want %v", got, want)
		}
	}
}

func TestMultibranch_CreateManagedUser_UnionEcho(t *testing.T) {
	users := newStubManagedUsers()
	engine := newSuperAdminEngine(users, multibranchCatalogue(), domain.RoleSuperAdmin)

	body := `{"name":"Admin Multi","email":"multi@thc.local","password":"Secret123!","nik":"3578010100000001",` +
		`"role":"admin","location_id":"` + branchAUUID + `","location_ids":["` + branchAUUID + `","` + branchBUUID + `"]}`
	rec := serveJSON(engine, "POST", "/users", body)
	mustStatus(t, rec, http.StatusCreated)
	data := decodeData[map[string]any](t, mustSuccess(t, rec))
	assertSubset(t, "User", data)
	if data["location_id"] != branchAUUID {
		t.Fatalf("primary must stay location_id, got %v", data["location_id"])
	}
	mustLocationIDs(t, data, branchAUUID, branchBUUID)
	if len(users.created) != 1 {
		t.Fatalf("expected 1 created account, got %d", len(users.created))
	}
	mustStoreUnion(t, users.created[0].LocationIDs, branchAUUID, branchBUUID)
}

func TestMultibranch_CreateManagedUser_ScalarOnlyYieldsSingleton(t *testing.T) {
	users := newStubManagedUsers()
	engine := newSuperAdminEngine(users, multibranchCatalogue(), domain.RoleSuperAdmin)

	body := `{"name":"Admin Solo","email":"solo@thc.local","password":"Secret123!","nik":"3578010100000002",` +
		`"role":"admin","location_id":"` + branchAUUID + `"}`
	rec := serveJSON(engine, "POST", "/users", body)
	mustStatus(t, rec, http.StatusCreated)
	data := decodeData[map[string]any](t, mustSuccess(t, rec))
	assertSubset(t, "User", data)
	mustLocationIDs(t, data, branchAUUID)
	if len(users.created) != 1 {
		t.Fatalf("expected 1 created account, got %d", len(users.created))
	}
	mustStoreUnion(t, users.created[0].LocationIDs, branchAUUID)
}

func TestMultibranch_UpdateManagedUser_KeepEchoesPrimary(t *testing.T) {
	loc := branchAUUID
	users := newStubManagedUsers(managedAccount("target-1", "admin@thc.local", domain.RoleAdmin, &loc))
	engine := newSuperAdminEngine(users, multibranchCatalogue(), domain.RoleSuperAdmin)

	rec := serveJSON(engine, "PATCH", "/users/target-1", `{"name":"Tetap Sini"}`)
	mustStatus(t, rec, http.StatusOK)
	data := decodeData[map[string]any](t, mustSuccess(t, rec))
	assertSubset(t, "User", data)
	if data["location_id"] != branchAUUID {
		t.Fatalf("keep must hold the primary, got %v", data["location_id"])
	}
	mustLocationIDs(t, data, branchAUUID)
}

func TestMultibranch_UpdateManagedUser_UnionMove(t *testing.T) {
	loc := branchAUUID
	users := newStubManagedUsers(managedAccount("target-1", "admin@thc.local", domain.RoleAdmin, &loc))
	engine := newSuperAdminEngine(users, multibranchCatalogue(), domain.RoleSuperAdmin)

	rec := serveJSON(engine, "PATCH", "/users/target-1",
		`{"location_ids":["`+branchAUUID+`","`+branchBUUID+`"]}`)
	mustStatus(t, rec, http.StatusOK)
	data := decodeData[map[string]any](t, mustSuccess(t, rec))
	assertSubset(t, "User", data)
	if data["location_id"] != branchAUUID {
		t.Fatalf("primary must stay the stored branch, got %v", data["location_id"])
	}
	mustLocationIDs(t, data, branchAUUID, branchBUUID)
	mustStoreUnion(t, users.byID["target-1"].User.LocationIDs, branchAUUID, branchBUUID)
}

func TestMultibranch_ExplicitEmptyIs400(t *testing.T) {
	create := `{"name":"Admin Kosong","email":"kosong@thc.local","password":"Secret123!","nik":"3578010100000003",` +
		`"role":"admin","location_id":"` + branchAUUID + `","location_ids":[]}`

	users := newStubManagedUsers()
	engine := newSuperAdminEngine(users, multibranchCatalogue(), domain.RoleSuperAdmin)
	rec := serveJSON(engine, "POST", "/users", create)
	mustStatus(t, rec, http.StatusBadRequest)
	if env := decodeEnvelope(t, rec); env.Error == nil || env.Error.Code != "VALIDATION_ERROR" {
		t.Fatalf("explicit [] must be 400 VALIDATION_ERROR, got %q", rec.Body.String())
	}
	if len(users.created) != 0 {
		t.Fatal("rejected create must not touch the store")
	}

	loc := branchAUUID
	users2 := newStubManagedUsers(managedAccount("target-1", "admin@thc.local", domain.RoleAdmin, &loc))
	engine2 := newSuperAdminEngine(users2, multibranchCatalogue(), domain.RoleSuperAdmin)
	rec = serveJSON(engine2, "PATCH", "/users/target-1", `{"location_ids":[]}`)
	mustStatus(t, rec, http.StatusBadRequest)
	if env := decodeEnvelope(t, rec); env.Error == nil || env.Error.Code != "VALIDATION_ERROR" {
		t.Fatalf("explicit [] must be 400 VALIDATION_ERROR, got %q", rec.Body.String())
	}
	kept := users2.byID["target-1"]
	if kept.User.LocationID == nil || *kept.User.LocationID != domain.UUID(branchAUUID) {
		t.Fatalf("refused patch must not touch the row, got %v", kept.User.LocationID)
	}
}

func TestMultibranch_UnknownLocationIs400(t *testing.T) {
	users := newStubManagedUsers()
	engine := newSuperAdminEngine(users, multibranchCatalogue(), domain.RoleSuperAdmin)

	body := `{"name":"Admin Asing","email":"asing@thc.local","password":"Secret123!","nik":"3578010100000004",` +
		`"role":"admin","location_id":"` + branchAUUID + `","location_ids":["` + branchAUUID + `","` + multibranchGhostUUID + `"]}`
	rec := serveJSON(engine, "POST", "/users", body)
	mustStatus(t, rec, http.StatusBadRequest)
	if env := decodeEnvelope(t, rec); env.Error == nil || env.Error.Code != "VALIDATION_ERROR" {
		t.Fatalf("unknown branch must be 400 VALIDATION_ERROR, got %q", rec.Body.String())
	}
	if len(users.created) != 0 {
		t.Fatal("rejected create must not touch the store")
	}
}

func TestMultibranch_VendorLocationKeysAre400(t *testing.T) {
	users := newStubManagedUsers()
	engine := newSuperAdminEngine(users, multibranchCatalogue(), domain.RoleSuperAdmin)

	body := `{"name":"Teknisi Lintas","email":"lintas@vendor.local","password":"Secret123!","nik":"3578010200000001",` +
		`"role":"vendor","location_ids":["` + branchAUUID + `"]}`
	rec := serveJSON(engine, "POST", "/users", body)
	mustStatus(t, rec, http.StatusBadRequest)
	if env := decodeEnvelope(t, rec); env.Error == nil || env.Error.Code != "VALIDATION_ERROR" {
		t.Fatalf("vendor location keys must be 400 VALIDATION_ERROR, got %q", rec.Body.String())
	}
	if len(users.created) != 0 {
		t.Fatal("rejected create must not touch the store")
	}
}

func TestMultibranch_CreateSecurity_UnionEcho(t *testing.T) {
	users := newStubUserStore()
	master := &stubMasterStore{locations: []domain.Location{
		{ID: domain.UUID(branchAUUID), Name: "Kantor Cabang A"},
		{ID: domain.UUID(branchBUUID), Name: "Kantor Cabang B"},
	}}
	engine := gin.New()
	engine.Use(withActor(domain.RoleSuperAdmin, ""))
	h := handlers.NewUserHandler(users, master, "role-security")
	engine.POST("/users/security", h.CreateSecurity)

	body := `{"name":"Pengawas Multi","email":"multisec@thc.local","password":"Secret123!",` +
		`"location_id":"` + branchAUUID + `","location_ids":["` + branchAUUID + `","` + branchBUUID + `"]}`
	rec := serveJSON(engine, "POST", "/users/security", body)
	mustStatus(t, rec, http.StatusCreated)
	data := decodeData[map[string]any](t, mustSuccess(t, rec))
	assertSubset(t, "User", data)
	if data["location_id"] != branchAUUID {
		t.Fatalf("primary must stay location_id, got %v", data["location_id"])
	}
	mustLocationIDs(t, data, branchAUUID, branchBUUID)
	if len(users.created) != 1 {
		t.Fatalf("expected 1 created account, got %d", len(users.created))
	}
	mustStoreUnion(t, users.created[0].LocationIDs, branchAUUID, branchBUUID)
}

func TestMultibranch_UpdateSecurity_UnionMove(t *testing.T) {
	store := newStubSecurityDeleteStore(securityUser("sec-1", "s1@thc.local", branchAUUID))
	engine := newSecurityLocationEngine(store, branchCatalogue(), domain.RoleSuperAdmin, "")

	rec := serveJSON(engine, "PATCH", "/users/security/sec-1",
		`{"location_ids":["`+branchAUUID+`","`+branchBUUID+`"]}`)
	mustStatus(t, rec, http.StatusOK)
	data := decodeData[map[string]any](t, mustSuccess(t, rec))
	assertSubset(t, "User", data)
	if data["location_id"] != branchAUUID {
		t.Fatalf("primary must stay the stored branch, got %v", data["location_id"])
	}
	mustLocationIDs(t, data, branchAUUID, branchBUUID)
	mustStoreUnion(t, store.users["sec-1"].LocationIDs, branchAUUID, branchBUUID)
}

func TestMultibranch_AdminOutOfScopeIs403(t *testing.T) {
	users := newStubUserStore()
	master := &stubMasterStore{locations: []domain.Location{
		{ID: domain.UUID(branchAUUID), Name: "Kantor Cabang A"},
		{ID: domain.UUID(branchBUUID), Name: "Kantor Cabang B"},
	}}
	engine := gin.New()
	engine.Use(withActor(domain.RoleAdmin, branchAUUID))
	h := handlers.NewUserHandler(users, master, "role-security")
	engine.POST("/users/security", h.CreateSecurity)

	body := `{"name":"Pengawas Asing","email":"asingsec@thc.local","password":"Secret123!",` +
		`"location_ids":["` + branchBUUID + `"]}`
	rec := serveJSON(engine, "POST", "/users/security", body)
	mustStatus(t, rec, http.StatusForbidden)
	if env := decodeEnvelope(t, rec); env.Error == nil || env.Error.Code != "FORBIDDEN_BRANCH" {
		t.Fatalf("out-of-scope ids must be 403 FORBIDDEN_BRANCH, got %q", rec.Body.String())
	}
	if len(users.created) != 0 {
		t.Fatal("refused create must not touch the store")
	}
}

func TestMultibranch_AdminSecurityMoveWithIDsOutOfScopeIs403(t *testing.T) {
	store := newStubSecurityDeleteStore(securityUser("sec-1", "s1@thc.local", branchAUUID))
	engine := newSecurityLocationEngine(store, branchCatalogue(), domain.RoleAdmin, branchAUUID)

	rec := serveJSON(engine, "PATCH", "/users/security/sec-1",
		`{"location_ids":["`+branchBUUID+`"]}`)
	mustStatus(t, rec, http.StatusForbidden)
	if env := decodeEnvelope(t, rec); env.Error == nil || env.Error.Code != "FORBIDDEN_BRANCH" {
		t.Fatalf("admin location move must be 403 FORBIDDEN_BRANCH, got %q", rec.Body.String())
	}
	kept := store.users["sec-1"]
	if kept.LocationID == nil || *kept.LocationID != domain.UUID(branchAUUID) {
		t.Fatalf("refused move must not touch the row, got %v", kept.LocationID)
	}
}

func TestMultibranch_AdminSecurityMoveWithIDsInScopeIsAllowed(t *testing.T) {
	store := newStubSecurityDeleteStore(securityUser("sec-1", "s1@thc.local", branchAUUID))
	engine := newSecurityLocationEngine(store, branchCatalogue(), domain.RoleAdmin, branchAUUID)

	rec := serveJSON(engine, "PATCH", "/users/security/sec-1",
		`{"location_ids":["`+branchAUUID+`"]}`)
	mustStatus(t, rec, http.StatusOK)
}

func TestMultibranch_SecurityExplicitEmptyIs400(t *testing.T) {
	engine := gin.New()
	engine.Use(withActor(domain.RoleSuperAdmin, ""))
	h := handlers.NewUserHandler(newStubUserStore(), &stubMasterStore{}, "role-security")
	engine.POST("/users/security", h.CreateSecurity)

	rec := serveJSON(engine, "POST", "/users/security",
		`{"name":"Pengawas Kosong","email":"kosongsec@thc.local","password":"Secret123!",` +
			`"location_id":"` + branchAUUID + `","location_ids":[]}`)
	mustStatus(t, rec, http.StatusBadRequest)
	if env := decodeEnvelope(t, rec); env.Error == nil || env.Error.Code != "VALIDATION_ERROR" {
		t.Fatalf("explicit [] must be 400 VALIDATION_ERROR, got %q", rec.Body.String())
	}

	store := newStubSecurityDeleteStore(securityUser("sec-1", "s1@thc.local", branchAUUID))
	moveEngine := newSecurityLocationEngine(store, branchCatalogue(), domain.RoleSuperAdmin, "")
	rec = serveJSON(moveEngine, "PATCH", "/users/security/sec-1", `{"location_ids":[]}`)
	mustStatus(t, rec, http.StatusBadRequest)
	if env := decodeEnvelope(t, rec); env.Error == nil || env.Error.Code != "VALIDATION_ERROR" {
		t.Fatalf("explicit [] must be 400 VALIDATION_ERROR, got %q", rec.Body.String())
	}
}

func TestMultibranch_SecurityUnknownLocationIs400(t *testing.T) {
	store := newStubSecurityDeleteStore(securityUser("sec-1", "s1@thc.local", branchAUUID))
	engine := newSecurityLocationEngine(store, branchCatalogue(), domain.RoleSuperAdmin, "")

	rec := serveJSON(engine, "PATCH", "/users/security/sec-1",
		`{"location_ids":["`+branchAUUID+`","`+multibranchGhostUUID+`"]}`)
	mustStatus(t, rec, http.StatusBadRequest)
	if env := decodeEnvelope(t, rec); env.Error == nil || env.Error.Code != "VALIDATION_ERROR" {
		t.Fatalf("unknown branch must be 400 VALIDATION_ERROR, got %q", rec.Body.String())
	}
	kept := store.users["sec-1"]
	if kept.LocationID == nil || *kept.LocationID != domain.UUID(branchAUUID) {
		t.Fatalf("refused move must not touch the row, got %v", kept.LocationID)
	}
}

func TestMultibranch_UpdateManagedUser_UnknownLocationIs400(t *testing.T) {
	loc := branchAUUID
	users := newStubManagedUsers(managedAccount("target-1", "admin@thc.local", domain.RoleAdmin, &loc))
	engine := newSuperAdminEngine(users, multibranchCatalogue(), domain.RoleSuperAdmin)

	rec := serveJSON(engine, "PATCH", "/users/target-1",
		`{"location_ids":["`+branchAUUID+`","`+multibranchGhostUUID+`"]}`)
	mustStatus(t, rec, http.StatusBadRequest)
	if env := decodeEnvelope(t, rec); env.Error == nil || env.Error.Code != "VALIDATION_ERROR" {
		t.Fatalf("unknown branch must be 400 VALIDATION_ERROR, got %q", rec.Body.String())
	}
	kept := users.byID["target-1"]
	if kept.User.LocationID == nil || *kept.User.LocationID != domain.UUID(branchAUUID) {
		t.Fatalf("refused patch must not touch the row, got %v", kept.User.LocationID)
	}
}
