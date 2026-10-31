package handlers_test

import (
	"net/http"
	"testing"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/handlers"
	"thc-vms/backend/internal/domain"
)

func newRegisterEngine(svc *stubAuthService) *gin.Engine {
	engine := gin.New()
	h := handlers.NewAuthHandler(svc)
	engine.POST("/auth/register", h.Register)
	return engine
}

func TestRegister_Returns201WithInactiveUser(t *testing.T) {
	profile := cannedAuthProfile()
	profile.Role = domain.RoleVendor
	profile.Status = domain.UserStatusInactive
	profile.Type = domain.UserTypeExternal
	profile.LocationID = nil
	profile.LocationName = nil
	svc := &stubAuthService{profile: profile}
	engine := newRegisterEngine(svc)

	rec := serveJSON(engine, "POST", "/auth/register", `{"name":"Dimas","email":"dimas@vendor.example","password":"Password123!","phone":"081234567890","nik":"3201010101900001"}`)
	mustStatus(t, rec, http.StatusCreated)
	user := decodeData[map[string]any](t, mustSuccess(t, rec))
	assertSubset(t, "User", user)
	if user["role"] != "vendor" {
		t.Fatalf("role = %v, want vendor (server-derived, never from the body)", user["role"])
	}
	if user["status"] != "inactive" {
		t.Fatalf("status = %v, want inactive (never immediately usable)", user["status"])
	}
	if user["location_id"] != nil {
		t.Fatalf("location_id = %v, want JSON null for vendor", user["location_id"])
	}
	if _, present := user["password_hash"]; present {
		t.Fatal("registration response must never leak the password hash")
	}
	if svc.lastRegisterInput == nil {
		t.Fatal("usecase input was not recorded")
	}
	if svc.lastRegisterInput.Name != "Dimas" || svc.lastRegisterInput.NIK != "3201010101900001" {
		t.Fatalf("usecase input = %+v, want the trimmed account fields", svc.lastRegisterInput)
	}
	if svc.lastRegisterInput.VendorID != nil {
		t.Fatalf("vendor_id = %v, want nil when absent", svc.lastRegisterInput.VendorID)
	}
}

func TestRegister_ForwardsCatalogueVendorID(t *testing.T) {
	profile := cannedAuthProfile()
	profile.Role = domain.RoleVendor
	profile.Status = domain.UserStatusInactive
	svc := &stubAuthService{profile: profile}
	engine := newRegisterEngine(svc)

	rec := serveJSON(engine, "POST", "/auth/register", `{"name":"Dimas","email":"dimas@vendor.example","password":"Password123!","nik":"3201010101900001","vendor_id":"11111111-1111-1111-1111-111111111111"}`)
	mustStatus(t, rec, http.StatusCreated)
	if svc.lastRegisterInput == nil || svc.lastRegisterInput.VendorID == nil {
		t.Fatalf("vendor_id was not forwarded: %+v", svc.lastRegisterInput)
	}
	if string(*svc.lastRegisterInput.VendorID) != "11111111-1111-1111-1111-111111111111" {
		t.Fatalf("vendor_id = %q, want the parsed catalogue id", *svc.lastRegisterInput.VendorID)
	}
}

func TestRegister_RejectsMalformedVendorID(t *testing.T) {
	svc := &stubAuthService{profile: cannedAuthProfile()}
	engine := newRegisterEngine(svc)

	rec := serveJSON(engine, "POST", "/auth/register", `{"name":"Dimas","email":"dimas@vendor.example","password":"Password123!","nik":"3201010101900001","vendor_id":"bukan-uuid"}`)
	mustStatus(t, rec, http.StatusBadRequest)
	env := decodeEnvelope(t, rec)
	if env.Success || env.Error == nil || env.Error.Code != "VALIDATION_ERROR" {
		t.Fatalf("want the VALIDATION_ERROR envelope, got %q", rec.Body.String())
	}
	if env.Error.Message != "vendor_id tidak valid." {
		t.Fatalf("message = %q, want the vendor_id diagnosis", env.Error.Message)
	}
}

func TestRegister_MapsDuplicateEmailTo409(t *testing.T) {
	svc := &stubAuthService{registerErr: domain.ErrConflict}
	engine := newRegisterEngine(svc)

	rec := serveJSON(engine, "POST", "/auth/register", `{"name":"Dimas","email":"dimas@vendor.example","password":"Password123!","nik":"3201010101900001"}`)
	mustStatus(t, rec, http.StatusConflict)
	env := decodeEnvelope(t, rec)
	if env.Success || env.Error == nil || env.Error.Code != "CONFLICT" {
		t.Fatalf("want the CONFLICT envelope, got %q", rec.Body.String())
	}
}

func TestRegister_RejectsMalformedBody(t *testing.T) {
	svc := &stubAuthService{profile: cannedAuthProfile()}
	engine := newRegisterEngine(svc)

	rec := serveJSON(engine, "POST", "/auth/register", `{"name":`)
	mustStatus(t, rec, http.StatusBadRequest)
}
