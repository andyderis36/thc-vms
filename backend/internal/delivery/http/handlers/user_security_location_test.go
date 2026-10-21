package handlers_test

import (
	"net/http"
	"testing"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/handlers"
	"thc-vms/backend/internal/domain"
)

// Katalog cabang untuk uji mutasi lokasi. UUID-nya kanonik karena
// domain.ParseUUID menolak nilai di luar bentuk 8-4-4-4-12.
const (
	branchAUUID = "11111111-1111-4111-8111-111111111111"
	branchBUUID = "22222222-2222-4222-8222-222222222222"
	branchCUUID = "33333333-3333-4333-8333-333333333333"
)

// newSecurityLocationEngine mounts PATCH /users/security/:id on top of the
// shared security fake, but with a caller-supplied master-data catalogue so
// the "cabang tujuan tak dikenal" case can be told apart from a valid move.
func newSecurityLocationEngine(store *stubSecurityDeleteStore, master *stubMasterStore, role domain.RoleName, loc string) *gin.Engine {
	engine := gin.New()
	engine.Use(withActor(role, loc))
	h := handlers.NewUserHandler(store, master, "role-security")
	engine.PATCH("/users/security/:id", h.UpdateSecurity)
	return engine
}

func branchCatalogue() *stubMasterStore {
	return &stubMasterStore{locations: []domain.Location{
		{ID: domain.UUID(branchAUUID), Name: "Kantor Cabang A"},
		{ID: domain.UUID(branchBUUID), Name: "Kantor Cabang B"},
	}}
}

// TestUpdateSecurity_SuperAdminMovesAccountToAnotherBranch pins the new
// contract: super_admin may reassign a satpam to another branch, the row
// really moves, and the response carries the new branch.
func TestUpdateSecurity_SuperAdminMovesAccountToAnotherBranch(t *testing.T) {
	store := newStubSecurityDeleteStore(securityUser("sec-1", "s1@thc.local", branchAUUID))
	engine := newSecurityLocationEngine(store, branchCatalogue(), domain.RoleSuperAdmin, "")

	rec := serveJSON(engine, "PATCH", "/users/security/sec-1", `{"location_id":"`+branchBUUID+`"}`)
	mustStatus(t, rec, http.StatusOK)

	moved := store.users["sec-1"]
	if moved.LocationID == nil || *moved.LocationID != domain.UUID(branchBUUID) {
		t.Fatalf("row must sit on the new branch, got %v", moved.LocationID)
	}
	data := decodeData[map[string]any](t, mustSuccess(t, rec))
	if data["location_id"] != branchBUUID {
		t.Fatalf("response must carry the new branch: %v", data["location_id"])
	}
	if data["location_name"] != "Kantor Cabang B" {
		t.Fatalf("response must carry the new branch name: %v", data["location_name"])
	}
}

// TestUpdateSecurity_SuperAdminMovesAccountOutOfForeignBranch pins that the
// national bypass really is national: the target may live on a branch the
// caller does not own.
func TestUpdateSecurity_SuperAdminMovesAccountOutOfForeignBranch(t *testing.T) {
	store := newStubSecurityDeleteStore(securityUser("sec-2", "s2@thc.local", branchCUUID))
	engine := newSecurityLocationEngine(store, branchCatalogue(), domain.RoleSuperAdmin, "")

	rec := serveJSON(engine, "PATCH", "/users/security/sec-2", `{"location_id":"`+branchAUUID+`"}`)
	mustStatus(t, rec, http.StatusOK)
	if store.users["sec-2"].LocationID == nil || *store.users["sec-2"].LocationID != domain.UUID(branchAUUID) {
		t.Fatalf("row must sit on the new branch, got %v", store.users["sec-2"].LocationID)
	}
}

// TestUpdateSecurity_BranchAdminCannotSetLocation is the isolation guard: a
// branch admin is refused with 403 when it sends location_id — even when it
// names its own branch — and the row is never touched.
func TestUpdateSecurity_BranchAdminCannotSetLocation(t *testing.T) {
	for _, target := range []string{branchAUUID, branchBUUID} {
		store := newStubSecurityDeleteStore(securityUser("sec-1", "s1@thc.local", branchAUUID))
		engine := newSecurityLocationEngine(store, branchCatalogue(), domain.RoleAdmin, branchAUUID)

		rec := serveJSON(engine, "PATCH", "/users/security/sec-1", `{"location_id":"`+target+`"}`)
		mustStatus(t, rec, http.StatusForbidden)
		env := decodeEnvelope(t, rec)
		if env.Error == nil || env.Error.Code != "FORBIDDEN_BRANCH" || env.Error.Message == "" {
			t.Fatalf("admin refusal must be 403 FORBIDDEN_BRANCH with a message, got %q", rec.Body.String())
		}
		kept := store.users["sec-1"]
		if kept.LocationID == nil || *kept.LocationID != domain.UUID(branchAUUID) {
			t.Fatalf("refused move must not touch the row, got %v", kept.LocationID)
		}
	}
}

// TestUpdateSecurity_MalformedLocationIDIs400 pins the format rule: a
// super_admin sending a non-UUID branch id gets 400 VALIDATION_ERROR.
func TestUpdateSecurity_MalformedLocationIDIs400(t *testing.T) {
	store := newStubSecurityDeleteStore(securityUser("sec-1", "s1@thc.local", branchAUUID))
	engine := newSecurityLocationEngine(store, branchCatalogue(), domain.RoleSuperAdmin, "")

	rec := serveJSON(engine, "PATCH", "/users/security/sec-1", `{"location_id":"bukan-uuid"}`)
	mustStatus(t, rec, http.StatusBadRequest)
	env := decodeEnvelope(t, rec)
	if env.Error == nil || env.Error.Code != "VALIDATION_ERROR" {
		t.Fatalf("malformed branch must be 400 VALIDATION_ERROR, got %q", rec.Body.String())
	}
	kept := store.users["sec-1"]
	if kept.LocationID == nil || *kept.LocationID != domain.UUID(branchAUUID) {
		t.Fatalf("refused move must not touch the row, got %v", kept.LocationID)
	}
}

// TestUpdateSecurity_UnknownLocationIs404 pins the "branch tujuan tak
// ada" case: a well-formed but unknown branch id is a clean 404, never a 500.
func TestUpdateSecurity_UnknownLocationIs404(t *testing.T) {
	store := newStubSecurityDeleteStore(securityUser("sec-1", "s1@thc.local", branchAUUID))
	engine := newSecurityLocationEngine(store, branchCatalogue(), domain.RoleSuperAdmin, "")

	rec := serveJSON(engine, "PATCH", "/users/security/sec-1", `{"location_id":"`+branchCUUID+`"}`)
	mustStatus(t, rec, http.StatusNotFound)
	env := decodeEnvelope(t, rec)
	if env.Error == nil || env.Error.Code != "NOT_FOUND" {
		t.Fatalf("unknown branch must be 404 NOT_FOUND, got %q", rec.Body.String())
	}
	kept := store.users["sec-1"]
	if kept.LocationID == nil || *kept.LocationID != domain.UUID(branchAUUID) {
		t.Fatalf("refused move must not touch the row, got %v", kept.LocationID)
	}
}

// TestUpdateSecurity_AbsentOrNullLocationKeepsBranch pins the "keep the
// current branch" semantics of the contract: an absent member and an
// explicit null both leave the stored branch untouched.
func TestUpdateSecurity_AbsentOrNullLocationKeepsBranch(t *testing.T) {
	for _, body := range []string{`{"name":"Tetap Sini"}`, `{"name":"Tetap Sini","location_id":null}`} {
		store := newStubSecurityDeleteStore(securityUser("sec-1", "s1@thc.local", branchAUUID))
		engine := newSecurityLocationEngine(store, branchCatalogue(), domain.RoleSuperAdmin, "")

		rec := serveJSON(engine, "PATCH", "/users/security/sec-1", body)
		mustStatus(t, rec, http.StatusOK)
		kept := store.users["sec-1"]
		if kept.LocationID == nil || *kept.LocationID != domain.UUID(branchAUUID) {
			t.Fatalf("body %s must keep the branch, got %v", body, kept.LocationID)
		}
	}
}

// TestUpdateSecurity_LocationOnlyMoveIsNotAnEmptyPatch guards the
// interaction with the shared patch validator: a PATCH carrying nothing but
// location_id is a real change, never the "Tidak ada perubahan" 400.
func TestUpdateSecurity_LocationOnlyMoveIsNotAnEmptyPatch(t *testing.T) {
	store := newStubSecurityDeleteStore(securityUser("sec-1", "s1@thc.local", branchAUUID))
	engine := newSecurityLocationEngine(store, branchCatalogue(), domain.RoleSuperAdmin, "")

	rec := serveJSON(engine, "PATCH", "/users/security/sec-1", `{"location_id":"`+branchBUUID+`"}`)
	mustStatus(t, rec, http.StatusOK)
}
