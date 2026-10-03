package handlers_test

import (
	"net/http"
	"testing"

	"golang.org/x/crypto/bcrypt"

	"thc-vms/backend/internal/domain"
)

// TestUpdateSecurity_PartialEdit pins PATCH /users/security/:id: an admin
// edits only its own branch (name/phone/password), cross-branch is 403,
// non-security targets 404, and blank members are 400.
func TestUpdateSecurity_PartialEdit(t *testing.T) {
	store := newStubSecurityDeleteStore(securityUser("sec-1", "s1@thc.local", "loc-own"))
	engine := newSecurityDeleteEngine(store, domain.RoleAdmin, "loc-own")

	rec := serve(engine, "PATCH", "/users/security/sec-1", []byte(`{"name":"Satpam Baru","phone":"0801"}`), "application/json")
	mustStatus(t, rec, http.StatusOK)
	updated := store.users["sec-1"]
	if updated.Name != "Satpam Baru" || updated.Phone != "0801" || updated.Email != "s1@thc.local" {
		t.Fatalf("partial edit wrong: %+v", updated)
	}

	rec = serve(engine, "PATCH", "/users/security/sec-1", []byte(`{"password":"Baru1234!"}`), "application/json")
	mustStatus(t, rec, http.StatusOK)
	if err := bcrypt.CompareHashAndPassword([]byte(store.users["sec-1"].PasswordHash), []byte("Baru1234!")); err != nil {
		t.Fatalf("password must be bcrypt-rehashed: %v", err)
	}

	for _, tc := range []struct{ path, body string }{
		{"/users/security/sec-1", `{"name":""}`},
		{"/users/security/sec-1", `{"password":""}`},
		{"/users/security/sec-1", `{}`},
	} {
		if rec := serve(engine, "PATCH", tc.path, []byte(tc.body), "application/json"); rec.Code != http.StatusBadRequest {
			t.Fatalf("PATCH %s %s: status = %d, want 400", tc.path, tc.body, rec.Code)
		}
	}

	mustStatus(t, serve(engine, "PATCH", "/users/security/ghost", []byte(`{"name":"X"}`), "application/json"), http.StatusNotFound)

	other := newStubSecurityDeleteStore(securityUser("sec-9", "s9@thc.local", "loc-other"))
	otherEngine := newSecurityDeleteEngine(other, domain.RoleAdmin, "loc-own")
	mustStatus(t, serve(otherEngine, "PATCH", "/users/security/sec-9", []byte(`{"name":"X"}`), "application/json"), http.StatusForbidden)
}
