package handlers_test

import (
	"testing"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/handlers"
	"thc-vms/backend/internal/domain"
)

func newGateEngine(svc *fakeGateService) *gin.Engine {
	engine := gin.New()
	engine.Use(withActor(domain.RoleSecurity, "loc-A"))
	h := handlers.NewGateHandler(svc)
	engine.POST("/visits/:id/checkin", h.CheckIn)
	engine.POST("/visits/:id/checkout", h.CheckOut)
	return engine
}

func TestCheckIn_PhotoIsOptional(t *testing.T) {
	svc := &fakeGateService{}
	engine := newGateEngine(svc)

	rec := serveJSON(engine, "POST", "/visits/VST-0000000001/checkin", `{"notes": "tamu datang"}`)
	mustStatus(t, rec, 200)
	mustSuccess(t, rec)
	if svc.lastInput.PhotoURL != nil {
		t.Fatalf("photo must stay nil when absent, got %q", *svc.lastInput.PhotoURL)
	}
	if svc.lastKey != "VST-0000000001" {
		t.Fatalf("key = %q, want the VST- code passed through", svc.lastKey)
	}
}

func TestCheckIn_WindowViolationReturns400WithTheMandatedMessage(t *testing.T) {
	svc := &fakeGateService{checkInErr: domain.CheckInWindowExceeded()}
	engine := newGateEngine(svc)

	rec := serveJSON(engine, "POST", "/visits/visit-1/checkin", `{}`)
	mustStatus(t, rec, 400)
	env := decodeEnvelope(t, rec)
	if env.Success {
		t.Fatalf("success must be false on window violation")
	}
	if env.Error == nil {
		t.Fatalf("missing error body: %q", rec.Body.String())
	}
	const want = "Kunjungan belum dibuka atau sudah melewati batas waktu toleransi."
	if env.Error.Message != want {
		t.Fatalf("message = %q, want byte-for-byte %q", env.Error.Message, want)
	}
}

func TestCheckOut_DoubleCheckoutSurfacesConflict(t *testing.T) {
	svc := &fakeGateService{checkOutErr: domain.Conflict("Kunjungan sudah di-check-out.")}
	engine := newGateEngine(svc)

	rec := serve(engine, "POST", "/visits/visit-1/checkout", nil, "")
	mustStatus(t, rec, 409)
	env := decodeEnvelope(t, rec)
	if env.Success || env.Error == nil {
		t.Fatalf("expected failure envelope, got %q", rec.Body.String())
	}
}

func TestCheckOut_Success(t *testing.T) {
	svc := &fakeGateService{}
	engine := newGateEngine(svc)

	rec := serve(engine, "POST", "/visits/visit-1/checkout", nil, "")
	mustStatus(t, rec, 200)
	mustSuccess(t, rec)
	if string(svc.lastOutID) != "visit-1" {
		t.Fatalf("checkout id = %q", svc.lastOutID)
	}
}
