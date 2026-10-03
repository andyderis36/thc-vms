package handlers_test

import (
	"fmt"
	"net/http"
	"testing"

	"golang.org/x/crypto/bcrypt"

	"thc-vms/backend/internal/domain"
)

// TestSuperAdmin_UpdateUser pins PATCH /users/:id: a partial edit applies and
// keeps the untouched columns, blank/incompatible members are 400, ghosts are
// 404 and a duplicate email is 409 CONFLICT. Role, type, status and password
// have no body members and can never change here.
func TestSuperAdmin_UpdateUser(t *testing.T) {
	var locID = "22222222-2222-2222-2222-222222222222"

	t.Run("200 partial edit keeps the rest", func(t *testing.T) {
		users := newStubManagedUsers(managedAccount("target-1", "lama@thc.local", domain.RoleAdmin, &locID))
		engine := newSuperAdminEngine(users, newStubLocationAdmin(), domain.RoleSuperAdmin)

		rec := serveJSON(engine, "PATCH", "/users/target-1", `{"name":"Baru","phone":"0800"}`)
		mustStatus(t, rec, http.StatusOK)
		data := decodeData[map[string]any](t, mustSuccess(t, rec))
		assertSubset(t, "User", data)
		if data["name"] != "Baru" || data["email"] != "lama@thc.local" {
			t.Fatalf("partial projection wrong: %v", data)
		}
		if data["location_id"] != locID {
			t.Fatalf("location must be kept, got %v", data["location_id"])
		}
	})

	t.Run("200 vendor email-only edit", func(t *testing.T) {
		users := newStubManagedUsers(managedAccount("pic-1", "lama@vendor.local", domain.RoleVendor, nil))
		engine := newSuperAdminEngine(users, newStubLocationAdmin(), domain.RoleSuperAdmin)

		rec := serveJSON(engine, "PATCH", "/users/pic-1", `{"email":"baru@vendor.local"}`)
		mustStatus(t, rec, http.StatusOK)
		data := decodeData[map[string]any](t, mustSuccess(t, rec))
		if data["email"] != "baru@vendor.local" || data["location_id"] != nil {
			t.Fatalf("vendor projection wrong: %v", data)
		}
	})

	t.Run("200 password reset rehashes", func(t *testing.T) {
		users := newStubManagedUsers(managedAccount("adm-1", "a@thc.local", domain.RoleAdmin, &locID))
		engine := newSuperAdminEngine(users, newStubLocationAdmin(), domain.RoleSuperAdmin)

		rec := serveJSON(engine, "PATCH", "/users/adm-1", `{"password":"Baru1234!"}`)
		mustStatus(t, rec, http.StatusOK)
		stored := users.byID["adm-1"].User
		if stored.PasswordHash == "Baru1234!" || stored.PasswordHash == "" {
			t.Fatal("password must be stored bcrypt-hashed, never plaintext")
		}
		if err := bcrypt.CompareHashAndPassword([]byte(stored.PasswordHash), []byte("Baru1234!")); err != nil {
			t.Fatalf("stored hash must verify: %v", err)
		}
	})

	t.Run("400 matrix", func(t *testing.T) {
		users := newStubManagedUsers(
			managedAccount("adm-1", "a@thc.local", domain.RoleAdmin, &locID),
			managedAccount("pic-1", "p@vendor.local", domain.RoleVendor, nil),
		)
		engine := newSuperAdminEngine(users, newStubLocationAdmin(), domain.RoleSuperAdmin)

		bad := []struct{ path, body string }{
			{"/users/adm-1", `{}`},
			{"/users/adm-1", `{"name":"  "}`},
			{"/users/adm-1", `{"email":""}`},
			{"/users/adm-1", `{"password":""}`},
			{"/users/adm-1", `{"location_id":"not-a-uuid"}`},
			{"/users/adm-1", `{"vendor_id":"` + locID + `"}`},
			{"/users/pic-1", `{"location_id":"` + locID + `"}`},
		}
		for _, tc := range bad {
			if rec := serveJSON(engine, "PATCH", tc.path, tc.body); rec.Code != http.StatusBadRequest {
				t.Fatalf("PATCH %s %s: status = %d, want 400: %q", tc.path, tc.body, rec.Code, rec.Body.String())
			}
		}
	})

	t.Run("self password reset needs proof; other superadmin forbidden", func(t *testing.T) {
		hash, err := bcrypt.GenerateFromPassword([]byte("Lama123!"), bcrypt.MinCost)
		if err != nil {
			t.Fatal(err)
		}
		self := managedAccount("actor-1", "saya@thc.local", domain.RoleSuperAdmin, nil)
		self.User.PasswordHash = string(hash)
		other := managedAccount("pusat-9", "pusat@thc.local", domain.RoleSuperAdmin, nil)
		other.User.PasswordHash = string(hash)
		users := newStubManagedUsers(self, other)
		engine := newSuperAdminEngine(users, newStubLocationAdmin(), domain.RoleSuperAdmin)

		mustStatus(t, serveJSON(engine, "PATCH", "/users/actor-1", `{"password":"Baru1234!"}`), http.StatusBadRequest)

		rec := serveJSON(engine, "PATCH", "/users/actor-1", `{"password":"Baru1234!","current_password":"Salah!"}`)
		mustStatus(t, rec, http.StatusUnauthorized)
		if env := decodeEnvelope(t, rec); env.Error == nil || env.Error.Code != "INVALID_CREDENTIALS" {
			t.Fatalf("wrong proof must be 401 INVALID_CREDENTIALS, got %q", rec.Body.String())
		}
		if err := bcrypt.CompareHashAndPassword([]byte(users.byID["actor-1"].User.PasswordHash), []byte("Lama123!")); err != nil {
			t.Fatal("refused reset must not rotate the hash")
		}

		rec = serveJSON(engine, "PATCH", "/users/actor-1", `{"password":"Baru1234!","current_password":"Lama123!"}`)
		mustStatus(t, rec, http.StatusOK)
		if err := bcrypt.CompareHashAndPassword([]byte(users.byID["actor-1"].User.PasswordHash), []byte("Baru1234!")); err != nil {
			t.Fatalf("proved reset must rotate the hash: %v", err)
		}

		mustStatus(t, serveJSON(engine, "PATCH", "/users/pusat-9", `{"password":"Baru1234!","current_password":"Lama123!"}`), http.StatusForbidden)
	})

	t.Run("404 ghost and 409 duplicate", func(t *testing.T) {
		users := newStubManagedUsers(managedAccount("adm-1", "a@thc.local", domain.RoleAdmin, &locID))
		engine := newSuperAdminEngine(users, newStubLocationAdmin(), domain.RoleSuperAdmin)

		mustStatus(t, serveJSON(engine, "PATCH", "/users/ghost", `{"name":"X"}`), http.StatusNotFound)

		users.updateUserErr = fmt.Errorf("repository: uniqueness clash: %w", domain.ErrConflict)
		rec := serveJSON(engine, "PATCH", "/users/adm-1", `{"email":"kembar@thc.local"}`)
		mustStatus(t, rec, http.StatusConflict)
		env := decodeEnvelope(t, rec)
		if env.Error == nil || env.Error.Code != "CONFLICT" {
			t.Fatalf("duplicate email must be 409 CONFLICT, got %q", rec.Body.String())
		}
	})
}
