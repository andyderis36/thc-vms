package handlers_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/handlers"
	"thc-vms/backend/internal/domain"
)

// fakePendingNotices is a hand-written fake for
// domain.VendorRegistrationNoticeRepository: it replays one canned page and
// records the paging the handler asked for.
type fakePendingNotices struct {
	items        []domain.PendingVendorRegistration
	total        int64
	pendingCount int64
	err          error

	lastPage  int
	lastLimit int
	calls     int
}

func (f *fakePendingNotices) InsertPending(_ context.Context, _ domain.UUID) error {
	return nil
}

func (f *fakePendingNotices) ListPending(_ context.Context, page, limit int) ([]domain.PendingVendorRegistration, int64, int64, error) {
	f.calls++
	f.lastPage = page
	f.lastLimit = limit
	if f.err != nil {
		return nil, 0, 0, f.err
	}
	return f.items, f.total, f.pendingCount, nil
}

func (f *fakePendingNotices) Resolve(_ context.Context, _ domain.UUID, _ domain.VendorRegistrationStatus) error {
	return nil
}

func cannedPending() []domain.PendingVendorRegistration {
	created := time.Date(2026, time.October, 2, 9, 0, 0, 0, time.UTC)
	return []domain.PendingVendorRegistration{
		{
			VendorUserID: "11111111-1111-1111-1111-111111111111",
			Name:         "Dimas Prasetyo",
			Email:        "dimas@vendor.example",
			Phone:        "081234567890",
			NIK:          "3201010101900001",
			VendorName:   "PT Lintas Fiber",
			CreatedAt:    created,
			Status:       domain.VendorRegistrationPending,
		},
		{
			VendorUserID: "22222222-2222-2222-2222-222222222222",
			Name:         "Sinta",
			Email:        "sinta@vendor.example",
			Phone:        "081234567891",
			NIK:          "3201010101900002",
			VendorName:   "",
			CreatedAt:    created.Add(time.Hour),
			Status:       domain.VendorRegistrationPending,
		},
	}
}

func newPendingEngine(store domain.VendorRegistrationNoticeRepository) *gin.Engine {
	engine := gin.New()
	h := handlers.NewPendingRegistrationHandler(store)
	engine.GET("/notifications/pending-registrations", h.List)
	return engine
}

func TestPendingRegistrations_SuperadminSeesFrozenShape(t *testing.T) {
	store := &fakePendingNotices{items: cannedPending(), total: 2, pendingCount: 2}
	engine := gin.New()
	engine.Use(withActor(domain.RoleSuperAdmin, ""))
	engine.GET("/notifications/pending-registrations", handlers.NewPendingRegistrationHandler(store).List)

	rec := serve(engine, "GET", "/notifications/pending-registrations", nil, "")
	mustStatus(t, rec, http.StatusOK)
	data := asObject(t, mustSuccess(t, rec).Data)
	assertSubset(t, "PendingRegistrationList", data)
	if data["total"] != float64(2) || data["pending_count"] != float64(2) {
		t.Fatalf("total/pending_count = %v/%v, want 2/2", data["total"], data["pending_count"])
	}
	if data["page"] != float64(1) || data["limit"] != float64(20) {
		t.Fatalf("page/limit = %v/%v, want the 1/20 defaults", data["page"], data["limit"])
	}
	items, ok := data["items"].([]any)
	if !ok || len(items) != 2 {
		t.Fatalf("items wrong: %v", data["items"])
	}
	first := items[0].(map[string]any)
	assertSubset(t, "PendingRegistrationItem", first)
	if first["vendor_user_id"] != "11111111-1111-1111-1111-111111111111" {
		t.Fatalf("vendor_user_id = %v, want the pending account", first["vendor_user_id"])
	}
	if first["name"] != "Dimas Prasetyo" || first["email"] != "dimas@vendor.example" {
		t.Fatalf("identity = %v/%v, want the joined account row", first["name"], first["email"])
	}
	if first["status"] != "pending" {
		t.Fatalf("status = %v, want pending", first["status"])
	}
	if _, err := time.Parse(time.RFC3339, first["created_at"].(string)); err != nil {
		t.Fatalf("created_at = %v, want RFC3339: %v", first["created_at"], err)
	}
	if store.lastPage != 1 || store.lastLimit != 20 {
		t.Fatalf("port paging = %d/%d, want the 1/20 defaults", store.lastPage, store.lastLimit)
	}
}

func TestPendingRegistrations_ForwardsExplicitPaging(t *testing.T) {
	store := &fakePendingNotices{items: cannedPending(), total: 9, pendingCount: 9}
	engine := gin.New()
	engine.Use(withActor(domain.RoleSuperAdmin, ""))
	engine.GET("/notifications/pending-registrations", handlers.NewPendingRegistrationHandler(store).List)

	rec := serve(engine, "GET", "/notifications/pending-registrations?page=2&limit=5", nil, "")
	mustStatus(t, rec, http.StatusOK)
	data := asObject(t, mustSuccess(t, rec).Data)
	if data["page"] != float64(2) || data["limit"] != float64(5) {
		t.Fatalf("page/limit = %v/%v, want the echoed 2/5", data["page"], data["limit"])
	}
	if store.lastPage != 2 || store.lastLimit != 5 {
		t.Fatalf("port paging = %d/%d, want 2/5", store.lastPage, store.lastLimit)
	}
}

func TestPendingRegistrations_InvalidPagingFallsBackToDefaults(t *testing.T) {
	store := &fakePendingNotices{}
	engine := gin.New()
	engine.Use(withActor(domain.RoleSuperAdmin, ""))
	engine.GET("/notifications/pending-registrations", handlers.NewPendingRegistrationHandler(store).List)

	rec := serve(engine, "GET", "/notifications/pending-registrations?page=0&limit=banana", nil, "")
	mustStatus(t, rec, http.StatusOK)
	data := asObject(t, mustSuccess(t, rec).Data)
	if data["page"] != float64(1) || data["limit"] != float64(20) {
		t.Fatalf("page/limit = %v/%v, want the 1/20 defaults", data["page"], data["limit"])
	}
	if store.lastPage != 1 || store.lastLimit != 20 {
		t.Fatalf("port paging = %d/%d, want the 1/20 defaults", store.lastPage, store.lastLimit)
	}
}

func TestPendingRegistrations_LocationFilterIsRejected(t *testing.T) {
	store := &fakePendingNotices{}
	engine := gin.New()
	engine.Use(withActor(domain.RoleSuperAdmin, ""))
	engine.GET("/notifications/pending-registrations", handlers.NewPendingRegistrationHandler(store).List)

	rec := serve(engine, "GET", "/notifications/pending-registrations?location_id=11111111-1111-1111-1111-111111111111", nil, "")
	mustStatus(t, rec, http.StatusBadRequest)
	env := decodeEnvelope(t, rec)
	if env.Success || env.Error == nil || env.Error.Code != "VALIDATION_ERROR" {
		t.Fatalf("want the VALIDATION_ERROR envelope, got %q", rec.Body.String())
	}
	if store.calls != 0 {
		t.Fatal("a rejected filter must never reach the notices port")
	}
}

func TestPendingRegistrations_NonSuperAdminIsRefused(t *testing.T) {
	for _, role := range []domain.RoleName{domain.RoleAdmin, domain.RoleSecurity, domain.RoleVendor} {
		store := &fakePendingNotices{}
		engine := gin.New()
		engine.Use(withActor(role, "loc-A"))
		engine.GET("/notifications/pending-registrations", handlers.NewPendingRegistrationHandler(store).List)

		rec := serve(engine, "GET", "/notifications/pending-registrations", nil, "")
		mustStatus(t, rec, http.StatusForbidden)
		env := decodeEnvelope(t, rec)
		if env.Success || env.Error == nil || env.Error.Code == "" {
			t.Fatalf("role %s: want the failure envelope, got %q", role, rec.Body.String())
		}
		if store.calls != 0 {
			t.Fatalf("role %s: a refused caller must never reach the notices port", role)
		}
	}
}

func TestPendingRegistrations_RequiresIdentity(t *testing.T) {
	store := &fakePendingNotices{}
	engine := newPendingEngine(store)

	mustStatus(t, serve(engine, "GET", "/notifications/pending-registrations", nil, ""), http.StatusUnauthorized)
	if store.calls != 0 {
		t.Fatal("an unauthenticated caller must never reach the notices port")
	}
}

func TestPendingRegistrations_PortErrorPassesThrough(t *testing.T) {
	store := &fakePendingNotices{err: domain.ErrDatabase}
	engine := gin.New()
	engine.Use(withActor(domain.RoleSuperAdmin, ""))
	engine.GET("/notifications/pending-registrations", handlers.NewPendingRegistrationHandler(store).List)

	rec := serve(engine, "GET", "/notifications/pending-registrations", nil, "")
	mustStatus(t, rec, http.StatusInternalServerError)
	env := decodeEnvelope(t, rec)
	if env.Success || env.Error == nil {
		t.Fatalf("want the failure envelope, got %q", rec.Body.String())
	}
}
