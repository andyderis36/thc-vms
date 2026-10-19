package handlers_test

import (
	"net/http"
	"strings"
	"testing"

	"thc-vms/backend/internal/domain"
)

// vendorWithCompany builds a stored vendor console row that already carries a manual
// company, so the PATCH keep/clear cases start from a known state.
func vendorWithCompany(id, email, company string) domain.ManagedUser {
	account := managedAccount(id, email, domain.RoleVendor, nil)
	if company != "" {
		account.User.VendorNameOverride = strPtr(company)
	}
	return account
}

// createVendorBody builds a valid POST /users body for an external vendor with an
// optional vendor_name / vendor_id suffix.
func createVendorBody(nik, suffix string) string {
	return `{"name":"Teknisi","email":"tek@vendor.local","password":"Secret123!","nik":"` + nik + `","role":"vendor"` + suffix + `}`
}

// TestCreateUser_ManualVendorNameAccepted pins POST /users with a typed company
// and no catalogue link: the 201 response echoes vendor_name and the stored row
// keeps the override, so the account survives a company that is not (and must
// never become) catalogue master data.
func TestCreateUser_ManualVendorNameAccepted(t *testing.T) {
	users := newStubManagedUsers()
	engine := newSuperAdminEngine(users, newStubLocationAdmin(), domain.RoleSuperAdmin)

	rec := serveJSON(engine, "POST", "/users", createVendorBody(
		"3578010200000001", `,"vendor_name":"  PT Subkon Mandiri  "`))
	mustStatus(t, rec, http.StatusCreated)

	data := decodeData[map[string]any](t, mustSuccess(t, rec))
	if data["vendor_name"] != "PT Subkon Mandiri" {
		t.Errorf("vendor_name = %v, want the trimmed typed company", data["vendor_name"])
	}

	if len(users.created) != 1 {
		t.Fatalf("created %d rows, want 1", len(users.created))
	}
	stored := users.created[0].VendorNameOverride
	if stored == nil || *stored != "PT Subkon Mandiri" {
		t.Errorf("stored VendorNameOverride = %v, want the trimmed company", stored)
	}
	if users.created[0].VendorID != nil {
		t.Error("no vendor_id was sent, so none may be stored")
	}
}

// TestCreateUser_VendorIDWinsOverManualName pins the catalogue-wins rule on the
// create path: a body carrying both must store the link and DROP the manual
// text, so the read helper's override-otherwise-catalogue order stays
// unambiguous and a stale manual name can never shadow the catalogue.
func TestCreateUser_VendorIDWinsOverManualName(t *testing.T) {
	vendorID := "22222222-2222-2222-2222-222222222222"
	users := newStubManagedUsers()
	engine := newSuperAdminEngine(users, newStubLocationAdmin(), domain.RoleSuperAdmin)

	rec := serveJSON(engine, "POST", "/users", createVendorBody(
		"3578010200000001", `,"vendor_id":"`+vendorID+`","vendor_name":"PT Subkon Mandiri"`))
	mustStatus(t, rec, http.StatusCreated)

	if len(users.created) != 1 {
		t.Fatalf("created %d rows, want 1", len(users.created))
	}
	if users.created[0].VendorNameOverride != nil {
		t.Errorf("stored VendorNameOverride = %q, want nil when vendor_id wins",
			*users.created[0].VendorNameOverride)
	}
	if users.created[0].VendorID == nil || *users.created[0].VendorID != domain.UUID(vendorID) {
		t.Errorf("stored VendorID = %v, want the catalogue link", users.created[0].VendorID)
	}

	// The create projection carries no catalogue join, so vendor_name is null
	// here; the chosen catalogue name resolves on the next read.
	data := decodeData[map[string]any](t, mustSuccess(t, rec))
	if data["vendor_name"] != nil {
		t.Errorf("vendor_name = %v, want null while the catalogue name is unresolved", data["vendor_name"])
	}
}

// TestUpdateUser_ManualVendorNameSetKeepClear pins the phone-style tri-state on
// PATCH /users/:id at the HTTP edge: absent keeps the stored company, a filled
// value sets it, an empty value clears it to null. Each transition is checked
// on both the stored row and the echoed response.
func TestUpdateUser_ManualVendorNameSetKeepClear(t *testing.T) {
	t.Run("keep: absent member preserves the stored company", func(t *testing.T) {
		users := newStubManagedUsers(vendorWithCompany("vendor-1", "tek@vendor.local", "PT Lama"))
		engine := newSuperAdminEngine(users, newStubLocationAdmin(), domain.RoleSuperAdmin)

		rec := serveJSON(engine, "PATCH", "/users/vendor-1", `{"phone":"0899"}`)
		mustStatus(t, rec, http.StatusOK)

		stored := users.byID["vendor-1"].User.VendorNameOverride
		if stored == nil || *stored != "PT Lama" {
			t.Fatalf("stored VendorNameOverride = %v, want the untouched company", stored)
		}
		data := decodeData[map[string]any](t, mustSuccess(t, rec))
		if data["vendor_name"] != "PT Lama" {
			t.Errorf("vendor_name = %v, want the preserved company", data["vendor_name"])
		}
	})

	t.Run("set: filled member replaces the stored company", func(t *testing.T) {
		users := newStubManagedUsers(vendorWithCompany("vendor-1", "tek@vendor.local", "PT Lama"))
		engine := newSuperAdminEngine(users, newStubLocationAdmin(), domain.RoleSuperAdmin)

		rec := serveJSON(engine, "PATCH", "/users/vendor-1", `{"vendor_name":"  PT Baru  "}`)
		mustStatus(t, rec, http.StatusOK)

		stored := users.byID["vendor-1"].User.VendorNameOverride
		if stored == nil || *stored != "PT Baru" {
			t.Fatalf("stored VendorNameOverride = %v, want the trimmed replacement", stored)
		}
		data := decodeData[map[string]any](t, mustSuccess(t, rec))
		if data["vendor_name"] != "PT Baru" {
			t.Errorf("vendor_name = %v, want the replacement company", data["vendor_name"])
		}
	})

	t.Run("clear: empty member nulls the stored company", func(t *testing.T) {
		users := newStubManagedUsers(vendorWithCompany("vendor-1", "tek@vendor.local", "PT Lama"))
		engine := newSuperAdminEngine(users, newStubLocationAdmin(), domain.RoleSuperAdmin)

		rec := serveJSON(engine, "PATCH", "/users/vendor-1", `{"vendor_name":"   "}`)
		mustStatus(t, rec, http.StatusOK)

		if stored := users.byID["vendor-1"].User.VendorNameOverride; stored != nil {
			t.Fatalf("stored VendorNameOverride = %q, want nil after a clear", *stored)
		}
		data := decodeData[map[string]any](t, mustSuccess(t, rec))
		if data["vendor_name"] != nil {
			t.Errorf("vendor_name = %v, want null after a clear", data["vendor_name"])
		}
	})

	t.Run("catalogue link wins and clears a stored company", func(t *testing.T) {
		vendorID := "22222222-2222-2222-2222-222222222222"
		users := newStubManagedUsers(vendorWithCompany("vendor-1", "tek@vendor.local", "PT Lama"))
		engine := newSuperAdminEngine(users, newStubLocationAdmin(), domain.RoleSuperAdmin)

		rec := serveJSON(engine, "PATCH", "/users/vendor-1",
			`{"vendor_id":"`+vendorID+`","vendor_name":"PT Abai"}`)
		mustStatus(t, rec, http.StatusOK)

		if stored := users.byID["vendor-1"].User.VendorNameOverride; stored != nil {
			t.Errorf("stored VendorNameOverride = %q, want nil when vendor_id wins", *stored)
		}
		if users.byID["vendor-1"].User.VendorID == nil ||
			*users.byID["vendor-1"].User.VendorID != domain.UUID(vendorID) {
			t.Errorf("stored VendorID = %v, want the catalogue link", users.byID["vendor-1"].User.VendorID)
		}
	})
}

// TestUpdateUser_ManualVendorNameLength pins the 120-rune cap on the patch and
// confirms an overlong value never reaches the repository.
func TestUpdateUser_ManualVendorNameLength(t *testing.T) {
	t.Run("120 runes accepted", func(t *testing.T) {
		users := newStubManagedUsers(vendorWithCompany("vendor-1", "tek@vendor.local", ""))
		engine := newSuperAdminEngine(users, newStubLocationAdmin(), domain.RoleSuperAdmin)

		rec := serveJSON(engine, "PATCH", "/users/vendor-1",
			`{"vendor_name":`+mustJSON(t, strings.Repeat("A", 120))+`}`)
		mustStatus(t, rec, http.StatusOK)

		stored := users.byID["vendor-1"].User.VendorNameOverride
		if stored == nil || len([]rune(*stored)) != 120 {
			t.Errorf("stored company = %v, want 120 runes", stored)
		}
	})

	t.Run("121 runes refused", func(t *testing.T) {
		users := newStubManagedUsers(vendorWithCompany("vendor-1", "tek@vendor.local", ""))
		engine := newSuperAdminEngine(users, newStubLocationAdmin(), domain.RoleSuperAdmin)

		rec := serveJSON(engine, "PATCH", "/users/vendor-1",
			`{"vendor_name":`+mustJSON(t, strings.Repeat("A", 121))+`}`)
		msg := mustErrorCode(t, rec, http.StatusBadRequest, "VALIDATION_ERROR")
		if !strings.Contains(msg, "120 karakter") {
			t.Errorf("message = %q, want it to name the 120-rune bound", msg)
		}
		if stored := users.byID["vendor-1"].User.VendorNameOverride; stored != nil {
			t.Error("an overlong company must never reach the repository")
		}
	})
}

// TestUpdateUser_ManualVendorNameIsVendorOnly pins the role gate on the patch for
// every internal role, at the HTTP edge this time.
func TestUpdateUser_ManualVendorNameIsVendorOnly(t *testing.T) {
	locID := "11111111-1111-1111-1111-111111111111"
	locations := newStubLocationAdmin(domain.Location{ID: domain.UUID(locID), Name: "Cabang A"})

	cases := []struct {
		role string
		body string
		id   string
	}{
		{"admin", `{"vendor_name":"PT Subkon Mandiri"}`, "adm-1"},
		{"security", `{"vendor_name":"PT Subkon Mandiri"}`, "sec-1"},
		{"super_admin", `{"vendor_name":"PT Subkon Mandiri"}`, "pusat-1"},
	}
	for _, tc := range cases {
		t.Run(tc.role, func(t *testing.T) {
			users := newStubManagedUsers(managedAccount(
				tc.id, tc.id+"@thc.local", domain.RoleName(tc.role), &locID))
			engine := newSuperAdminEngine(users, locations, domain.RoleSuperAdmin)

			rec := serveJSON(engine, "PATCH", "/users/"+tc.id, tc.body)
			msg := mustErrorCode(t, rec, http.StatusBadRequest, "VALIDATION_ERROR")
			if !strings.Contains(msg, "vendor") {
				t.Errorf("message = %q, want it to name the vendor-only rule", msg)
			}
			if stored := users.byID[domain.UUID(tc.id)].User.VendorNameOverride; stored != nil {
				t.Error("a refused patch must never write the vendor company")
			}
		})
	}
}

// TestUpdateUser_BlankVendorNameIsNotKeep guards the subtlety that makes the
// tri-state work: an empty vendor_name means CLEAR, so it must not silently
// behave like "keep" and leave a stale company on screen.
func TestUpdateUser_BlankVendorNameIsNotKeep(t *testing.T) {
	users := newStubManagedUsers(vendorWithCompany("vendor-1", "tek@vendor.local", "PT Lama"))
	engine := newSuperAdminEngine(users, newStubLocationAdmin(), domain.RoleSuperAdmin)

	rec := serveJSON(engine, "PATCH", "/users/vendor-1", `{"vendor_name":""}`)
	mustStatus(t, rec, http.StatusOK)

	if stored := users.byID["vendor-1"].User.VendorNameOverride; stored != nil {
		t.Fatalf("an explicitly empty vendor_name must clear, stored = %q", *stored)
	}
}
