package handlers_test

import (
	"net/http"
	"testing"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/handlers"
	"thc-vms/backend/internal/domain"
)

func newMasterEngine(master *stubMasterStore, role domain.RoleName, loc string) *gin.Engine {
	engine := gin.New()
	engine.Use(withActor(role, loc))
	h := handlers.NewMasterHandler(master)
	engine.GET("/locations", h.ListLocations)
	engine.GET("/purposes", h.ListPurposes)
	return engine
}

func TestMasterData_ReturnsCatalogues(t *testing.T) {
	master := &stubMasterStore{
		locations: []domain.Location{
			{ID: "loc-1", Name: "Kantor Cabang Surabaya", Type: domain.LocationCabang, Address: "Jl. Raya 1", City: "Surabaya", Timezone: domain.TimezoneWIB, IsActive: true},
			{ID: "loc-2", Name: "POP Sawojajar", Type: domain.LocationPOP, Address: "Jl. Danau 2", City: "Malang", Timezone: domain.TimezoneWIB, IsActive: true},
		},
		purposes: []domain.Purpose{
			{ID: "pur-1", Name: "Maintenance", IsActive: true},
			{ID: "pur-2", Name: "Survey", IsActive: true},
		},
	}
	engine := newMasterEngine(master, domain.RoleAdmin, "loc-1")

	t.Run("locations carry exactly the openapi field set", func(t *testing.T) {
		rec := serve(engine, "GET", "/locations", nil, "")
		mustStatus(t, rec, http.StatusOK)
		items := decodeData[[]map[string]any](t, mustSuccess(t, rec))
		if len(items) != 2 {
			t.Fatalf("expected 2 locations, got %d", len(items))
		}
		for _, item := range items {
			assertSubset(t, "Location", item)
		}
		if items[0]["type"] != "cabang" || items[0]["timezone"] != "WIB" {
			t.Fatalf("location enums wrong: %v", items[0])
		}
	})

	t.Run("purposes carry exactly id and name", func(t *testing.T) {
		rec := serve(engine, "GET", "/purposes", nil, "")
		mustStatus(t, rec, http.StatusOK)
		items := decodeData[[]map[string]any](t, mustSuccess(t, rec))
		if len(items) != 2 {
			t.Fatalf("expected 2 purposes, got %d", len(items))
		}
		for _, item := range items {
			assertSubset(t, "Purpose", item)
		}
	})

	t.Run("anonymous catalogue reads are refused", func(t *testing.T) {
		bare := gin.New()
		h := handlers.NewMasterHandler(master)
		bare.GET("/locations", h.ListLocations)
		rec := serve(bare, "GET", "/locations", nil, "")
		mustStatus(t, rec, http.StatusUnauthorized)
	})
}
