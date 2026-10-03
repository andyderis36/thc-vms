package handlers_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/handlers"
	"thc-vms/backend/internal/domain"
)

// flagAwareMasterStore is a fake for domain.MasterDataRepository that honours
// the onlyActive flag, unlike stubMasterStore (which predates the
// ?active_only= query and always returns its rows verbatim).
type flagAwareMasterStore struct {
	stubMasterStore
	lastActiveOnly *bool
}

func (s *flagAwareMasterStore) ListLocations(_ context.Context, onlyActive bool) ([]domain.Location, error) {
	s.lastActiveOnly = &onlyActive
	if !onlyActive {
		return s.locations, nil
	}
	out := []domain.Location{}
	for _, loc := range s.locations {
		if loc.IsActive {
			out = append(out, loc)
		}
	}
	return out, nil
}

func newFlagAwareMasterEngine(master *flagAwareMasterStore, role domain.RoleName) *gin.Engine {
	engine := gin.New()
	engine.Use(withActor(role, ""))
	h := handlers.NewMasterHandler(master)
	engine.GET("/locations", h.ListLocations)
	return engine
}

func TestListLocations_ActiveOnlyDefaultsToTrue(t *testing.T) {
	master := &flagAwareMasterStore{stubMasterStore: stubMasterStore{locations: []domain.Location{
		{ID: "loc-1", Name: "Cabang Aktif", Type: domain.LocationCabang, Timezone: domain.TimezoneWIB, IsActive: true},
		{ID: "loc-2", Name: "POP Mati", Type: domain.LocationPOP, Timezone: domain.TimezoneWITA, IsActive: false},
	}}}
	engine := newFlagAwareMasterEngine(master, domain.RoleAdmin)

	rec := serve(engine, "GET", "/locations", nil, "")
	mustStatus(t, rec, http.StatusOK)
	if master.lastActiveOnly == nil || *master.lastActiveOnly != true {
		t.Fatalf("default must pass activeOnly=true, got %+v", master.lastActiveOnly)
	}
	items := decodeData[[]map[string]any](t, mustSuccess(t, rec))
	if len(items) != 1 {
		t.Fatalf("default must filter to the active row, got %d: %v", len(items), items)
	}
	assertSubset(t, "Location", items[0])
	if items[0]["is_active"] != true {
		t.Fatalf("active row must carry is_active=true, got %v", items[0])
	}
}

func TestListLocations_ActiveOnlyFalseShowsAll(t *testing.T) {
	master := &flagAwareMasterStore{stubMasterStore: stubMasterStore{locations: []domain.Location{
		{ID: "loc-1", Name: "Cabang Aktif", Type: domain.LocationCabang, Timezone: domain.TimezoneWIB, IsActive: true},
		{ID: "loc-2", Name: "POP Mati", Type: domain.LocationPOP, Timezone: domain.TimezoneWITA, IsActive: false},
	}}}
	engine := newFlagAwareMasterEngine(master, domain.RoleSuperAdmin)

	rec := serve(engine, "GET", "/locations?active_only=false", nil, "")
	mustStatus(t, rec, http.StatusOK)
	if master.lastActiveOnly == nil || *master.lastActiveOnly != false {
		t.Fatalf("active_only=false must pass activeOnly=false, got %+v", master.lastActiveOnly)
	}
	items := decodeData[[]map[string]any](t, mustSuccess(t, rec))
	if len(items) != 2 {
		t.Fatalf("active_only=false must show every row, got %d", len(items))
	}
	seen := map[string]any{}
	for _, item := range items {
		assertSubset(t, "Location", item)
		seen[item["id"].(string)] = item["is_active"]
	}
	if seen["loc-1"] != true || seen["loc-2"] != false {
		t.Fatalf("rows must carry honest flags, got %v", seen)
	}

	mustStatus(t, serve(engine, "GET", "/locations?active_only=true", nil, ""), http.StatusOK)
	if *master.lastActiveOnly != true {
		t.Fatalf("active_only=true must pass activeOnly=true, got %v", *master.lastActiveOnly)
	}
	mustStatus(t, serve(engine, "GET", "/locations?active_only=bogus", nil, ""), http.StatusBadRequest)
}
