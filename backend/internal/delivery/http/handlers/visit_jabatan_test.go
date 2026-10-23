package handlers_test

import (
	"encoding/json"
	"testing"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/handlers"
	"thc-vms/backend/internal/domain"
)

func newJabatanEngine(svc *fakeVisitService, role domain.RoleName) *gin.Engine {
	engine := gin.New()
	engine.Use(withActor(role, ""))
	h := handlers.NewVisitHandler(svc)
	engine.GET("/jabatan", h.ListJabatan)
	return engine
}

func TestListJabatan_ReturnsSuccessEnvelopeWithStringArray(t *testing.T) {
	svc := &fakeVisitService{jabatan: []string{"Mandor", "Teknisi"}}
	engine := newJabatanEngine(svc, domain.RoleVendor)

	rec := serve(engine, "GET", "/jabatan", nil, "")
	mustStatus(t, rec, 200)
	env := mustSuccess(t, rec)

	var values []string
	if err := json.Unmarshal(env.Data, &values); err != nil {
		t.Fatalf("data is not a string array: %v: %q", err, string(env.Data))
	}
	if len(values) != 2 || values[0] != "Mandor" || values[1] != "Teknisi" {
		t.Fatalf("data = %v, want [Mandor Teknisi]", values)
	}
}

func TestListJabatan_EmptyListRendersEmptyArray(t *testing.T) {
	svc := &fakeVisitService{}
	engine := newJabatanEngine(svc, domain.RoleSecurity)

	rec := serve(engine, "GET", "/jabatan", nil, "")
	mustStatus(t, rec, 200)
	env := mustSuccess(t, rec)
	if string(env.Data) != "[]" {
		t.Fatalf("data = %q, want [] (never null)", string(env.Data))
	}
}

func TestGetVisit_IncludesVisitorJabatan(t *testing.T) {
	svc := &fakeVisitService{visitByKey: map[string]domain.VisitRequest{"visit-1": cannedVisit()}}
	engine := newVisitEngine(svc, domain.RoleSuperAdmin, "")

	rec := serve(engine, "GET", "/visits/visit-1", nil, "")
	mustStatus(t, rec, 200)
	env := mustSuccess(t, rec)

	var detail struct {
		Visitors []struct {
			Jabatan *string `json:"jabatan"`
		} `json:"visitors"`
	}
	if err := json.Unmarshal(env.Data, &detail); err != nil {
		t.Fatalf("detail does not decode: %v: %q", err, string(env.Data))
	}
	if len(detail.Visitors) != 1 || detail.Visitors[0].Jabatan == nil || *detail.Visitors[0].Jabatan != "Teknisi" {
		t.Fatalf("visitor jabatan = %+v, want Teknisi", detail.Visitors)
	}
}
