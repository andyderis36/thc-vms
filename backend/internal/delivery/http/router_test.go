package http_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	deliveryhttp "thc-vms/backend/internal/delivery/http"
	"thc-vms/backend/internal/delivery/http/handlers"
	"thc-vms/backend/internal/delivery/http/middleware"
	"thc-vms/backend/internal/domain"
	infraJWT "thc-vms/backend/internal/infrastructure/jwt"
	"thc-vms/backend/internal/usecase/auth"
	"thc-vms/backend/internal/usecase/gate"
	"thc-vms/backend/internal/usecase/visit"
)

func init() {
	gin.SetMode(gin.TestMode)
}

// denyParser refuses every token so unauthenticated requests exercise the
// 401 path without minting anything.
type denyParser struct{}

func (denyParser) Parse(_ string) (infraJWT.Claims, error) {
	return infraJWT.Claims{}, domain.ErrUnauthorized
}

// denyLoader refuses every profile load for the same reason.
type denyLoader struct{}

func (denyLoader) Me(_ context.Context, _ domain.UUID) (auth.Profile, error) {
	return auth.Profile{}, domain.ErrUnauthorized
}

// fakeAuthService answers every auth call with 401.
type fakeAuthService struct{}

func (fakeAuthService) Login(_ context.Context, _, _ string) (auth.LoginResult, error) {
	return auth.LoginResult{}, domain.ErrUnauthorized
}

func (fakeAuthService) Me(_ context.Context, _ domain.UUID) (auth.Profile, error) {
	return auth.Profile{}, domain.ErrUnauthorized
}

func (fakeAuthService) UpdateSelf(_ context.Context, _ auth.SelfIdentity, _ auth.SelfUpdate) (auth.Profile, error) {
	return auth.Profile{}, domain.ErrUnauthorized
}

func (fakeAuthService) Logout(_ context.Context) error { return nil }

func (fakeAuthService) RegisterVendor(_ context.Context, _ auth.RegisterVendorInput) (auth.Profile, error) {
	return auth.Profile{}, domain.ErrUnauthorized
}

// fakeVisitService answers every visit call with 404.
type fakeVisitService struct{}

func (fakeVisitService) ListVisits(_ context.Context, _ visit.Actor, _ visit.ListVisitsInput) ([]domain.VisitRequest, int64, error) {
	return nil, 0, domain.NotFoundEntity("Kunjungan")
}

func (fakeVisitService) CreateVisit(_ context.Context, _ visit.Actor, _ visit.CreateVisitInput) (domain.VisitRequest, error) {
	return domain.VisitRequest{}, domain.NotFoundEntity("Kunjungan")
}

func (fakeVisitService) GetVisit(_ context.Context, _ visit.Actor, _ string) (domain.VisitRequest, error) {
	return domain.VisitRequest{}, domain.NotFoundEntity("Kunjungan")
}

func (fakeVisitService) Approve(_ context.Context, _ visit.Actor, _ domain.UUID, _ string) error {
	return domain.NotFoundEntity("Kunjungan")
}

func (fakeVisitService) Reject(_ context.Context, _ visit.Actor, _ domain.UUID, _ string) error {
	return domain.NotFoundEntity("Kunjungan")
}

func (fakeVisitService) Cancel(_ context.Context, _ visit.Actor, _ domain.UUID, _ string) error {
	return domain.NotFoundEntity("Kunjungan")
}

func (fakeVisitService) Reschedule(_ context.Context, _ visit.Actor, _ domain.UUID, _, _ time.Time, _ string) error {
	return domain.NotFoundEntity("Kunjungan")
}

func (fakeVisitService) ListJabatan(_ context.Context) ([]string, error) {
	return nil, domain.NotFoundEntity("Kunjungan")
}

// fakeGateService answers every gate call with 404.
type fakeGateService struct{}

func (fakeGateService) CheckIn(_ context.Context, _ gate.Actor, _ string, _ gate.CheckInInput) (domain.CheckIn, error) {
	return domain.CheckIn{}, domain.NotFoundEntity("Kunjungan")
}

func (fakeGateService) CheckOut(_ context.Context, _ gate.Actor, _ domain.UUID) (domain.CheckOut, error) {
	return domain.CheckOut{}, domain.NotFoundEntity("Kunjungan")
}

// fakeMaster answers the catalogues with empty lists.
type fakeMaster struct{}

func (fakeMaster) ListLocations(_ context.Context, _ bool) ([]domain.Location, error) {
	return nil, nil
}

func (fakeMaster) FindLocationByID(_ context.Context, _ domain.UUID) (domain.Location, error) {
	return domain.Location{}, domain.ErrNotFound
}

func (fakeMaster) ListPurposes(_ context.Context, _ bool) ([]domain.Purpose, error) {
	return nil, nil
}

// fakeUsers refuses every account call with 404.
type fakeUsers struct{}

func (fakeUsers) FindByEmail(_ context.Context, _ string) (domain.User, error) {
	return domain.User{}, domain.ErrNotFound
}

func (fakeUsers) FindByID(_ context.Context, _ domain.UUID) (domain.User, error) {
	return domain.User{}, domain.ErrNotFound
}

func (fakeUsers) Create(_ context.Context, _ domain.User) (domain.User, error) {
	return domain.User{}, domain.ErrNotFound
}

func (fakeUsers) UpdateStatus(_ context.Context, _ domain.UUID, _ domain.UserStatus) error {
	return domain.ErrNotFound
}

func (fakeUsers) UpdateLastLogin(_ context.Context, _ domain.UUID, _ time.Time) error {
	return nil
}

func (fakeUsers) ListSecurity(_ context.Context, _ *domain.UUID) ([]domain.User, error) {
	return nil, nil
}

// fakeStorage refuses uploads with the storage sentinel.
type fakeStorage struct{}

func (fakeStorage) EnsureBucket(_ context.Context) error { return nil }

func (fakeStorage) Upload(_ context.Context, _ domain.UploadRequest) (domain.UploadResult, error) {
	return domain.UploadResult{}, domain.ErrStorageRejected
}

func (fakeStorage) PresignedURL(_ context.Context, _ string, _ time.Duration) (string, error) {
	return "", domain.ErrNotFound
}

func (fakeStorage) DeleteObject(_ context.Context, _ string) error { return nil }

func (fakeStorage) ObjectKeyFromStoredURL(_ string) (string, error) {
	return "", domain.ErrValidation
}

// testEngine builds the full MVP route table on fakes: no database, no
// MinIO, no tokens. The chain is the real middleware over denying
// collaborators, so refusals prove the production path.
func testEngine() *gin.Engine {
	auth := handlers.NewAuthHandler(fakeAuthService{})
	visits := handlers.NewVisitHandler(fakeVisitService{})
	gate := handlers.NewGateHandler(fakeGateService{})
	master := handlers.NewMasterHandler(fakeMaster{})
	users := handlers.NewUserHandler(fakeUsers{}, fakeMaster{}, "role-security")
	upload := handlers.NewUploadHandler(fakeStorage{}, 1024)
	health := deliveryhttp.NewHealthHandler(nil)
	limiter := middleware.NewRateLimiter(1000, time.Minute)
	return deliveryhttp.New(deliveryhttp.Deps{
		Auth: deliveryhttp.AuthRoutes{
			Login: auth.Login, Register: auth.Register, Me: auth.Me, PatchMe: auth.PatchMe, Logout: auth.Logout,
		},
		Users: deliveryhttp.UserRoutes{
			List: users.ListSecurity, Create: users.CreateSecurity, UpdateStatus: users.UpdateSecurityStatus,
			Delete: users.DeleteSecurity,
		},
		// Back-office superadmin kosong disengaja: withFallback mengubah tiap
		// member nil menjadi passthrough sehingga rute terdaftar (tidak 404);
		// perilaku handler-nya ditutup test handlers/superadmin_*_test.go.
		SuperAdmin: deliveryhttp.SuperAdminRoutes{},
		Master: deliveryhttp.MasterRoutes{
			Locations: master.ListLocations, Purposes: master.ListPurposes,
		},
		Visits: deliveryhttp.VisitRoutes{
			List: visits.List, Create: visits.Create, Get: visits.Get, QR: visits.QR,
			Reschedule: visits.Reschedule, Cancel: visits.Cancel,
			Approve: visits.Approve, Reject: visits.Reject,
		},
		Gate: deliveryhttp.GateRoutes{
			CheckIn: gate.CheckIn, CheckOut: gate.CheckOut,
		},
		Upload: deliveryhttp.UploadRoutes{Upload: upload.Upload},
		Health: deliveryhttp.HealthProbes{Health: health.Health, Ready: health.Ready},
		Chain: deliveryhttp.Chain{
			Recovery:     middleware.Recovery(),
			CORS:         middleware.CORS(),
			LoginLimiter: limiter.Middleware(),
			Authenticate: middleware.JWT(denyParser{}, denyLoader{}),
			AdminOnly: middleware.RequireRoles(
				domain.RoleSuperAdmin, domain.RoleAdmin),
			ApproveOnly: middleware.RequireRoles(
				domain.RoleSuperAdmin, domain.RoleAdmin),
			GateOnly: middleware.RequireRoles(
				domain.RoleSecurity, domain.RoleAdmin, domain.RoleSuperAdmin),
			SuperAdminOnly: middleware.RequireRoles(domain.RoleSuperAdmin),
		},
	})
}

func serve(engine *gin.Engine, method, path string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, req)
	return rec
}

// TestRouter_RegistersExactlyTheMVPContract asserts every one of the 42 wired
// operations resolves to a registered route: a registered route may answer
// 401/403/400/500 without credentials, but never 404. The two Phase-2
// feedback and incident endpoints must 404.
func TestRouter_RegistersExactlyTheMVPContract(t *testing.T) {
	engine := testEngine()
	wired := []struct{ method, path string }{
		{http.MethodPost, "/api/v1/auth/login"},
		{http.MethodPost, "/api/v1/auth/register"},
		{http.MethodGet, "/api/v1/health"},
		{http.MethodGet, "/api/v1/ready"},
		{http.MethodGet, "/api/v1/auth/me"},
		{http.MethodPatch, "/api/v1/auth/me"},
		{http.MethodPost, "/api/v1/auth/logout"},
		{http.MethodGet, "/api/v1/users/security"},
		{http.MethodPost, "/api/v1/users/security"},
		{http.MethodPatch, "/api/v1/users/security/some-id/status"},
		{http.MethodPatch, "/api/v1/users/security/some-id"},
		{http.MethodDelete, "/api/v1/users/security/some-id"},
		{http.MethodGet, "/api/v1/locations"},
		{http.MethodPost, "/api/v1/locations"},
		{http.MethodPatch, "/api/v1/locations/some-id"},
		{http.MethodDelete, "/api/v1/locations/some-id"},
		{http.MethodPost, "/api/v1/purposes"},
		{http.MethodPatch, "/api/v1/purposes/some-id"},
		{http.MethodDelete, "/api/v1/purposes/some-id"},
		{http.MethodGet, "/api/v1/users"},
		{http.MethodPost, "/api/v1/users"},
		{http.MethodPatch, "/api/v1/users/some-id/status"},
		{http.MethodPatch, "/api/v1/users/some-id"},
		{http.MethodDelete, "/api/v1/users/some-id"},
		{http.MethodGet, "/api/v1/purposes"},
		{http.MethodGet, "/api/v1/jabatan"},
		{http.MethodGet, "/api/v1/visits"},
		{http.MethodPost, "/api/v1/visits"},
		{http.MethodGet, "/api/v1/visits/some-id"},
		{http.MethodGet, "/api/v1/visits/some-id/file"},
		{http.MethodGet, "/api/v1/avatars/some-id"},
		{http.MethodPost, "/api/v1/visits/some-id/approve"},
		{http.MethodPost, "/api/v1/visits/some-id/reject"},
		{http.MethodPost, "/api/v1/visits/some-id/reschedule"},
		{http.MethodPost, "/api/v1/visits/some-id/cancel"},
		{http.MethodGet, "/api/v1/visits/some-id/qr"},
		{http.MethodPost, "/api/v1/visits/some-id/checkin"},
		{http.MethodPost, "/api/v1/visits/some-id/checkout"},
		{http.MethodDelete, "/api/v1/visits/some-id"},
		{http.MethodGet, "/api/v1/audit-logs"},
		{http.MethodGet, "/api/v1/notifications"},
		{http.MethodPost, "/api/v1/uploads"},
	}
	if len(wired) != 42 {
		t.Fatalf("contract drift: wired routes = %d, want 42", len(wired))
	}
	for _, route := range wired {
		rec := serve(engine, route.method, route.path)
		if rec.Code == http.StatusNotFound {
			t.Errorf("%s %s is not registered (404)", route.method, route.path)
		}
	}
	for _, forbidden := range []struct{ method, path string }{
		{http.MethodPost, "/api/v1/visits/some-id/feedback"},
		{http.MethodPost, "/api/v1/visits/some-id/incident"},
	} {
		if rec := serve(engine, forbidden.method, forbidden.path); rec.Code != http.StatusNotFound {
			t.Errorf("%s %s must 404, got %d", forbidden.method, forbidden.path, rec.Code)
		}
	}
}

// TestRouter_UnauthenticatedRequestsAreRefused asserts a protected route with
// no Authorization header answers 401 through the mandated envelope.
func TestRouter_UnauthenticatedRequestsAreRefused(t *testing.T) {
	engine := testEngine()
	rec := serve(engine, http.MethodGet, "/api/v1/auth/me")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401: %q", rec.Code, rec.Body.String())
	}
	var env struct {
		Success bool `json:"success"`
		Error   *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("response is not JSON: %v: %q", err, rec.Body.String())
	}
	if env.Success || env.Error == nil || env.Error.Code == "" || env.Error.Message == "" {
		t.Fatalf("response is not the failure envelope: %q", rec.Body.String())
	}
}
