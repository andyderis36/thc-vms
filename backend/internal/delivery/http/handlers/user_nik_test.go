package handlers_test

import (
	"context"
	"fmt"
	"net/http"
	"testing"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/handlers"
	"thc-vms/backend/internal/domain"
)

const (
	testAdminNIK  = "3578010100000001"
	testVendorNIK = "3578010200000001"
	testLocID     = "11111111-1111-1111-1111-111111111111"
)

// TestSuperAdmin_CreateUserNIK pins the NIK contract of POST /users: a valid
// 16-digit NIK is stored and echoed for admin/vendor, while a missing or
// malformed one is 400 and a valid row that collides on email is still 409.
func TestSuperAdmin_CreateUserNIK(t *testing.T) {
	t.Run("201 admin carries its NIK", func(t *testing.T) {
		users := newStubManagedUsers()
		locations := newStubLocationAdmin(domain.Location{ID: domain.UUID(testLocID), Name: "Cabang A"})
		engine := newSuperAdminEngine(users, locations, domain.RoleSuperAdmin)

		body := `{"name":"Admin Baru","email":"baru@thc.local","password":"Secret123!","nik":"` + testAdminNIK + `","role":"admin","location_id":"` + testLocID + `"}`
		rec := serveJSON(engine, "POST", "/users", body)
		mustStatus(t, rec, http.StatusCreated)
		data := decodeData[map[string]any](t, mustSuccess(t, rec))
		assertSubset(t, "User", data)
		if data["nik"] != testAdminNIK {
			t.Fatalf("response nik = %v, want %s", data["nik"], testAdminNIK)
		}
		if len(users.created) != 1 || users.created[0].NIK != testAdminNIK {
			t.Fatalf("stored NIK wrong: %+v", users.created)
		}
	})

	t.Run("400 when NIK is missing or malformed", func(t *testing.T) {
		users := newStubManagedUsers()
		engine := newSuperAdminEngine(users, newStubLocationAdmin(), domain.RoleSuperAdmin)

		bad := []string{
			`{"name":"A","email":"a@thc.local","password":"Secret123!","role":"admin","location_id":"` + testLocID + `"}`,
			`{"name":"A","email":"a@thc.local","password":"Secret123!","nik":"123","role":"admin","location_id":"` + testLocID + `"}`,
			`{"name":"A","email":"a@thc.local","password":"Secret123!","nik":"35780101000000AB","role":"admin","location_id":"` + testLocID + `"}`,
			`{"name":"P","email":"p@vendor.local","password":"Secret123!","role":"vendor"}`,
			`{"name":"P","email":"p@vendor.local","password":"Secret123!","nik":"123","role":"vendor"}`,
		}
		for _, body := range bad {
			if rec := serveJSON(engine, "POST", "/users", body); rec.Code != http.StatusBadRequest {
				t.Fatalf("body %s: status = %d, want 400: %q", body, rec.Code, rec.Body.String())
			}
		}
		if len(users.created) != 0 {
			t.Fatalf("refused creates must not touch the store: %+v", users.created)
		}
	})

	t.Run("409 survives a valid NIK", func(t *testing.T) {
		users := newStubManagedUsers()
		users.createErr = fmt.Errorf("repository: uniqueness clash: %w", domain.ErrConflict)
		engine := newSuperAdminEngine(users, newStubLocationAdmin(), domain.RoleSuperAdmin)

		body := `{"name":"Kembar","email":"dup@thc.local","password":"Secret123!","nik":"` + testVendorNIK + `","role":"vendor"}`
		rec := serveJSON(engine, "POST", "/users", body)
		mustStatus(t, rec, http.StatusConflict)
	})
}

// TestSuperAdmin_UpdateUserNIK pins PATCH /users/:id: a provided NIK follows
// the same per-role rule as create, while an absent key leaves the column
// untouched.
func TestSuperAdmin_UpdateUserNIK(t *testing.T) {
	var locID = testLocID

	t.Run("200 sets the NIK", func(t *testing.T) {
		users := newStubManagedUsers(managedAccount("target-1", "lama@thc.local", domain.RoleAdmin, &locID))
		engine := newSuperAdminEngine(users, newStubLocationAdmin(), domain.RoleSuperAdmin)

		rec := serveJSON(engine, "PATCH", "/users/target-1", `{"nik":"`+testAdminNIK+`"}`)
		mustStatus(t, rec, http.StatusOK)
		data := decodeData[map[string]any](t, mustSuccess(t, rec))
		assertSubset(t, "User", data)
		if data["nik"] != testAdminNIK {
			t.Fatalf("response nik = %v, want %s", data["nik"], testAdminNIK)
		}
	})

	t.Run("400 matrix for provided values", func(t *testing.T) {
		users := newStubManagedUsers(
			managedAccount("adm-1", "a@thc.local", domain.RoleAdmin, &locID),
			managedAccount("vendor-1", "p@vendor.local", domain.RoleVendor, nil),
		)
		engine := newSuperAdminEngine(users, newStubLocationAdmin(), domain.RoleSuperAdmin)

		bad := []struct{ path, body string }{
			{"/users/adm-1", `{"nik":""}`},
			{"/users/adm-1", `{"nik":"123"}`},
			{"/users/adm-1", `{"nik":"35780101000000AB"}`},
			{"/users/vendor-1", `{"nik":"12345678901234567"}`},
		}
		for _, tc := range bad {
			if rec := serveJSON(engine, "PATCH", tc.path, tc.body); rec.Code != http.StatusBadRequest {
				t.Fatalf("PATCH %s %s: status = %d, want 400: %q", tc.path, tc.body, rec.Code, rec.Body.String())
			}
		}
	})
}

// TestSecurityAccountNIKRejected pins the gate-staff refusal: a populated nik
// on either security write path is 400, because gate staff never carry a
// national identity number.
func TestSecurityAccountNIKRejected(t *testing.T) {
	t.Run("POST /users/security refuses a NIK", func(t *testing.T) {
		users := newStubUserStore()
		master := &stubMasterStore{locations: []domain.Location{{ID: "loc-own", Name: "Cabang Sendiri"}}}
		engine := newUserEngine(users, master, domain.RoleAdmin, "loc-own")

		body := `{"name":"Pengawas Baru","email":"baru@thc.local","password":"Secret123!","nik":"` + testAdminNIK + `"}`
		rec := serveJSON(engine, "POST", "/users/security", body)
		mustStatus(t, rec, http.StatusBadRequest)
		if len(users.created) != 0 {
			t.Fatal("refused create must not touch the store")
		}
	})

	t.Run("PATCH /users/security/:id refuses a NIK", func(t *testing.T) {
		store := newStubSecurityDeleteStore(securityUser("sec-1", "s1@thc.local", "loc-own"))
		engine := newSecurityDeleteEngine(store, domain.RoleAdmin, "loc-own")

		rec := serve(engine, "PATCH", "/users/security/sec-1", []byte(`{"nik":"`+testAdminNIK+`"}`), "application/json")
		mustStatus(t, rec, http.StatusBadRequest)
	})
}

// vendorCatalogueStore is an additive fake for the GET /vendors catalogue:
// the read-only stubMasterStore plus the active company list. A separate type
// (rather than widening stubMasterStore) keeps the older fakes compiling
// against the narrow MasterDataRepository port.
type vendorCatalogueStore struct {
	stubMasterStore
	vendors    []domain.Vendor
	vendorsErr error
}

// ListVendors serves the company catalogue through domain.VendorRepository.
func (s *vendorCatalogueStore) ListVendors(_ context.Context) ([]domain.Vendor, error) {
	if s.vendorsErr != nil {
		return nil, s.vendorsErr
	}
	return s.vendors, nil
}

func newVendorEngine(master *vendorCatalogueStore, role domain.RoleName) *gin.Engine {
	engine := gin.New()
	engine.Use(withActor(role, "loc-1"))
	h := handlers.NewMasterHandler(master)
	engine.GET("/vendors", h.ListVendors)
	return engine
}

// TestListVendors pins GET /vendors: every authenticated role receives
// exactly [{id, name}], anonymous callers are 401, and a store without the
// catalogue fails closed with 500 instead of panicking.
func TestListVendors(t *testing.T) {
	master := &vendorCatalogueStore{
		vendors: []domain.Vendor{
			{ID: "ven-1", Name: "PT Daya Power Mandiri"},
			{ID: "ven-2", Name: "PT Lintas Fiber"},
		},
	}

	t.Run("every role receives id and name only", func(t *testing.T) {
		for _, role := range []domain.RoleName{
			domain.RoleSuperAdmin, domain.RoleAdmin, domain.RoleSecurity, domain.RoleVendor,
		} {
			engine := newVendorEngine(master, role)
			rec := serve(engine, "GET", "/vendors", nil, "")
			mustStatus(t, rec, http.StatusOK)
			items := decodeData[[]map[string]any](t, mustSuccess(t, rec))
			if len(items) != 2 {
				t.Fatalf("role %s: expected 2 vendors, got %d", role, len(items))
			}
			for _, item := range items {
				if len(item) != 2 || item["id"] == nil || item["name"] == nil {
					t.Fatalf("role %s: vendor row must be exactly {id, name}, got %v", role, item)
				}
			}
		}
	})

	t.Run("anonymous reads are refused", func(t *testing.T) {
		bare := gin.New()
		h := handlers.NewMasterHandler(master)
		bare.GET("/vendors", h.ListVendors)
		mustStatus(t, serve(bare, "GET", "/vendors", nil, ""), http.StatusUnauthorized)
	})

	t.Run("narrow store fails closed without panicking", func(t *testing.T) {
		bare := gin.New()
		bare.Use(withActor(domain.RoleAdmin, "loc-1"))
		h := handlers.NewMasterHandler(&stubMasterStore{})
		bare.GET("/vendors", h.ListVendors)
		mustStatus(t, serve(bare, "GET", "/vendors", nil, ""), http.StatusInternalServerError)
	})
}
