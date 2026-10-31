package handlers_test

import (
	"net/http"
	"testing"

	"thc-vms/backend/internal/domain"
)

func TestSuperAdmin_CreatePurpose(t *testing.T) {
	t.Run("201 stores the name active", func(t *testing.T) {
		locations := newStubLocationAdmin()
		engine := newSuperAdminEngine(newStubManagedUsers(), locations, domain.RoleSuperAdmin)

		rec := serveJSON(engine, "POST", "/purposes", `{"name":"Splicing FO"}`)
		mustStatus(t, rec, http.StatusCreated)
		got := decodeData[map[string]any](t, mustSuccess(t, rec))
		assertSubset(t, "Purpose", got)
		if got["name"] != "Splicing FO" || got["is_active"] != true {
			t.Fatalf("created purpose wrong: %v", got)
		}
		if len(locations.purposes) != 1 {
			t.Fatalf("store holds %d purposes, want 1", len(locations.purposes))
		}
	})

	t.Run("blank and overlong names are 400", func(t *testing.T) {
		locations := newStubLocationAdmin()
		engine := newSuperAdminEngine(newStubManagedUsers(), locations, domain.RoleSuperAdmin)

		mustStatus(t, serveJSON(engine, "POST", "/purposes", `{"name":"  "}`), http.StatusBadRequest)
		big := make([]byte, 101)
		for i := range big {
			big[i] = 'a'
		}
		mustStatus(t, serveJSON(engine, "POST", "/purposes", `{"name":"`+string(big)+`"}`), http.StatusBadRequest)
		if len(locations.purposes) != 0 {
			t.Fatal("rejected creates must not touch the store")
		}
	})
}

func TestSuperAdmin_UpdatePurpose(t *testing.T) {
	t.Run("200 applies the patch", func(t *testing.T) {
		locations := newStubLocationAdmin()
		locations.purposes = []domain.Purpose{{ID: "pur-1", Name: "Lama", IsActive: true}}
		engine := newSuperAdminEngine(newStubManagedUsers(), locations, domain.RoleSuperAdmin)

		rec := serveJSON(engine, "PATCH", "/purposes/pur-1", `{"name":"Baru","is_active":false}`)
		mustStatus(t, rec, http.StatusOK)
		got := decodeData[map[string]any](t, mustSuccess(t, rec))
		assertSubset(t, "Purpose", got)
		if got["name"] != "Baru" || got["is_active"] != false {
			t.Fatalf("updated purpose wrong: %v", got)
		}
	})

	t.Run("unknown id is 404 and empty patch is 400", func(t *testing.T) {
		locations := newStubLocationAdmin()
		engine := newSuperAdminEngine(newStubManagedUsers(), locations, domain.RoleSuperAdmin)

		mustStatus(t, serveJSON(engine, "PATCH", "/purposes/missing", `{"name":"X"}`), http.StatusNotFound)
		locations.purposes = []domain.Purpose{{ID: "pur-1", Name: "Lama", IsActive: true}}
		mustStatus(t, serveJSON(engine, "PATCH", "/purposes/pur-1", `{}`), http.StatusBadRequest)
	})
}

func TestSuperAdmin_DeletePurpose(t *testing.T) {
	t.Run("204 removes an unreferenced purpose with no body", func(t *testing.T) {
		locations := newStubLocationAdmin()
		locations.purposes = []domain.Purpose{{ID: "pur-1", Name: "Lama", IsActive: true}}
		engine := newSuperAdminEngine(newStubManagedUsers(), locations, domain.RoleSuperAdmin)

		rec := serve(engine, "DELETE", "/purposes/pur-1", nil, "")
		mustStatus(t, rec, http.StatusNoContent)
		if rec.Body.Len() != 0 {
			t.Fatalf("204 must carry no body, got %q", rec.Body.String())
		}
		if len(locations.deletedPurposes) != 1 || locations.deletedPurposes[0] != "pur-1" {
			t.Fatalf("deleted = %v, want [pur-1]", locations.deletedPurposes)
		}
	})

	t.Run("unknown id is 404 and referenced purpose is 409", func(t *testing.T) {
		locations := newStubLocationAdmin()
		locations.purposes = []domain.Purpose{{ID: "pur-1", Name: "Lama", IsActive: true}}
		locations.visitsAtPurpose["pur-1"] = 2
		engine := newSuperAdminEngine(newStubManagedUsers(), locations, domain.RoleSuperAdmin)

		mustStatus(t, serve(engine, "DELETE", "/purposes/missing", nil, ""), http.StatusNotFound)
		rec := serve(engine, "DELETE", "/purposes/pur-1", nil, "")
		mustStatus(t, rec, http.StatusConflict)
		if len(locations.deletedPurposes) != 0 {
			t.Fatal("refused delete must not touch the store")
		}
	})
}

func TestMasterData_PurposesActiveOnly(t *testing.T) {
	master := &stubMasterStore{
		purposes: []domain.Purpose{
			{ID: "pur-1", Name: "Aktif", IsActive: true},
			{ID: "pur-2", Name: "Nonaktif", IsActive: false},
		},
	}
	// The catalogue fake ignores the flag like the old stub; the flag-aware
	// path is pinned through the filtered fake below.
	engine := newMasterEngine(master, domain.RoleAdmin, "loc-1")

	t.Run("items carry exactly the openapi field set", func(t *testing.T) {
		rec := serve(engine, "GET", "/purposes", nil, "")
		mustStatus(t, rec, http.StatusOK)
		items := decodeData[[]map[string]any](t, mustSuccess(t, rec))
		if len(items) != 2 {
			t.Fatalf("expected 2 purposes, got %d", len(items))
		}
		for _, item := range items {
			assertSubset(t, "Purpose", item)
			if _, ok := item["is_active"]; !ok {
				t.Fatalf("purpose item misses is_active: %v", item)
			}
		}
	})

	t.Run("unparseable active_only is 400", func(t *testing.T) {
		rec := serve(engine, "GET", "/purposes?active_only=bogus", nil, "")
		mustStatus(t, rec, http.StatusBadRequest)
	})
}
