package handlers_test

// Suite for GET /users/vendors: the vendor-ACCOUNT directory the visit form's
// owner picker consumes. It is the minimal projection (id, name, email,
// company) of ACTIVE vendor accounts only, gated to admin + super_admin.

import (
	"net/http"
	"testing"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/handlers"
	"thc-vms/backend/internal/domain"
)

// newVendorAccountsEngine mounts the handler on a bare engine. An empty role
// skips the identity middleware so the anonymous path is exercised directly.
func newVendorAccountsEngine(users *stubManagedUsers, role domain.RoleName) *gin.Engine {
	engine := gin.New()
	if role != "" {
		engine.Use(withActor(role, ""))
	}
	locations := newStubLocationAdmin()
	h := handlers.NewSuperAdminHandler(users, locations, locations, newStubVisitRepos(), "role-admin", "role-vendor")
	engine.GET("/users/vendors", h.ListVendorAccounts)
	return engine
}

// vendorAccountsFixture stages four vendor accounts: a catalogue+override row
// (catalogue wins), a manual-override-only row (trimmed), a companyless row
// (company null) and an inactive row (never offered).
func vendorAccountsFixture() *stubManagedUsers {
	catalogue := "PT Alpha Katalog"
	override := "  PT Alpha Manual  "
	inactiveOverride := "PT Tidur"
	return newStubManagedUsers(
		domain.ManagedUser{
			User: domain.User{
				ID: "vend-active-1", Name: "Andi", Email: "andi@vendor.test",
				Status: domain.UserStatusActive, VendorNameOverride: &override,
			},
			Role: domain.RoleVendor, VendorName: &catalogue,
		},
		domain.ManagedUser{
			User: domain.User{
				ID: "vend-active-2", Name: "Budi", Email: "budi@vendor.test",
				Status: domain.UserStatusActive, VendorNameOverride: &override,
			},
			Role: domain.RoleVendor,
		},
		domain.ManagedUser{
			User: domain.User{
				ID: "vend-active-3", Name: "Citra", Email: "citra@vendor.test",
				Status: domain.UserStatusActive,
			},
			Role: domain.RoleVendor,
		},
		domain.ManagedUser{
			User: domain.User{
				ID: "vend-inactive", Name: "Dodi", Email: "dodi@vendor.test",
				Status: domain.UserStatusInactive, VendorNameOverride: &inactiveOverride,
			},
			Role: domain.RoleVendor,
		},
	)
}

// TestListVendorAccounts_NoIdentityIsUnauthorized pins the 401 when the
// middleware stack did not establish an identity.
func TestListVendorAccounts_NoIdentityIsUnauthorized(t *testing.T) {
	engine := newVendorAccountsEngine(vendorAccountsFixture(), "")
	mustStatus(t, serve(engine, "GET", "/users/vendors", nil, ""), http.StatusUnauthorized)
}

// TestListVendorAccounts_NonAdminRolesAreForbidden pins the 403 sentinel for
// every authenticated role outside admin/super_admin.
func TestListVendorAccounts_NonAdminRolesAreForbidden(t *testing.T) {
	for _, role := range []domain.RoleName{domain.RoleVendor, domain.RoleSecurity} {
		engine := newVendorAccountsEngine(vendorAccountsFixture(), role)
		rec := serve(engine, "GET", "/users/vendors", nil, "")
		mustStatus(t, rec, http.StatusForbidden)
		env := decodeEnvelope(t, rec)
		if env.Error == nil || env.Error.Message != domain.ErrForbiddenBranch.Error() {
			t.Fatalf("role %s: refusal must carry the sentinel message, got %q", role, rec.Body.String())
		}
	}
}

// TestListVendorAccounts_AdminAndSuperAdminGetActiveRows pins the 200 body for
// both allowed roles: active rows only, minimal JSON keys, company resolved
// from the catalogue first and the trimmed manual override second.
func TestListVendorAccounts_AdminAndSuperAdminGetActiveRows(t *testing.T) {
	for _, role := range []domain.RoleName{domain.RoleAdmin, domain.RoleSuperAdmin} {
		users := vendorAccountsFixture()
		engine := newVendorAccountsEngine(users, role)

		rec := serve(engine, "GET", "/users/vendors", nil, "")
		mustStatus(t, rec, http.StatusOK)
		items := decodeData[[]map[string]any](t, mustSuccess(t, rec))
		if len(items) != 3 {
			t.Fatalf("role %s: rows = %d, want 3 active vendors", role, len(items))
		}
		want := []struct {
			id, name, email string
			company         any
		}{
			{"vend-active-1", "Andi", "andi@vendor.test", "PT Alpha Katalog"},
			{"vend-active-2", "Budi", "budi@vendor.test", "PT Alpha Manual"},
			{"vend-active-3", "Citra", "citra@vendor.test", nil},
		}
		for i, row := range items {
			if len(row) != 4 {
				t.Fatalf("row %d keys = %v, want exactly id/name/email/company", i, row)
			}
			for _, key := range []string{"id", "name", "email", "company"} {
				if _, ok := row[key]; !ok {
					t.Fatalf("row %d missing key %q: %v", i, key, row)
				}
			}
			if row["id"] != want[i].id || row["name"] != want[i].name || row["email"] != want[i].email {
				t.Fatalf("row %d = %v, want %+v", i, row, want[i])
			}
			if row["company"] != want[i].company {
				t.Fatalf("row %d company = %v, want %v", i, row["company"], want[i].company)
			}
		}
		// The handler scopes the repository query to vendor accounts and
		// forwards the trimmed search text.
		if users.lastFilter.Role == nil || *users.lastFilter.Role != domain.RoleVendor {
			t.Fatalf("role %s: filter role = %v, want vendor", role, users.lastFilter.Role)
		}
		if users.lastFilter.Search != "" {
			t.Fatalf("role %s: search = %q, want empty", role, users.lastFilter.Search)
		}
	}
}

// TestListVendorAccounts_TrimsSearch pins the ?search= trim before the
// repository filter.
func TestListVendorAccounts_TrimsSearch(t *testing.T) {
	users := vendorAccountsFixture()
	engine := newVendorAccountsEngine(users, domain.RoleAdmin)

	mustStatus(t, serve(engine, "GET", "/users/vendors?search=%20%20acme%20%20", nil, ""), http.StatusOK)
	if users.lastFilter.Search != "acme" {
		t.Fatalf("search = %q, want trimmed %q", users.lastFilter.Search, "acme")
	}
}

// TestListVendorAccounts_RepositoryFailureSurfaces pins the 500 mapping when
// the account directory read fails.
func TestListVendorAccounts_RepositoryFailureSurfaces(t *testing.T) {
	users := vendorAccountsFixture()
	users.listErr = domain.ErrDatabase
	engine := newVendorAccountsEngine(users, domain.RoleSuperAdmin)

	mustStatus(t, serve(engine, "GET", "/users/vendors", nil, ""), http.StatusInternalServerError)
}
