package handlers_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	deliveryhttp "thc-vms/backend/internal/delivery/http"
	"thc-vms/backend/internal/delivery/http/handlers"
	"thc-vms/backend/internal/delivery/http/middleware"
	"thc-vms/backend/internal/domain"
)

// stubMailLogStore adalah domain.MailLogRepository dalam memori: melayani
// halaman verdict kaleng dan mencatat filter terakhir agar pemetaan
// filter/pagination terpin.
type stubMailLogStore struct {
	items   []domain.MailLog
	total   int64
	err     error
	last    domain.MailLogFilter
	byID    map[string]domain.MailLog
	findErr error
}

func (s *stubMailLogStore) InsertQueued(_ context.Context, _ domain.MailLog) error { return nil }

func (s *stubMailLogStore) RecordVerdict(_ context.Context, _ domain.MailLog) error { return nil }

func (s *stubMailLogStore) List(_ context.Context, filter domain.MailLogFilter) ([]domain.MailLog, int64, error) {
	s.last = filter
	if s.err != nil {
		return nil, 0, s.err
	}
	return s.items, s.total, nil
}

func (s *stubMailLogStore) FindByID(_ context.Context, id domain.UUID) (domain.MailLog, error) {
	if s.findErr != nil {
		return domain.MailLog{}, s.findErr
	}
	if row, ok := s.byID[string(id)]; ok {
		return row, nil
	}
	return domain.MailLog{}, domain.NotFoundEntity("Log email")
}

func cannedMailLog() domain.MailLog {
	sent := time.Date(2026, time.October, 5, 10, 5, 0, 0, time.UTC)
	errMsg := "451 4.3.0 Greylisted"
	return domain.MailLog{
		ID:         "11111111-2222-3333-4444-555555555555",
		Recipients: []string{"tek@vendor.local"},
		Bcc:        []string{"bos@thc.id"},
		Subject:    "[THC-VMS] Kunjungan Disetujui",
		Template:   "visit_approved",
		Status:     domain.MailLogFailed,
		Attempts:   4,
		Error:      &errMsg,
		CreatedAt:  time.Date(2026, time.October, 5, 10, 0, 0, 0, time.UTC),
		SentAt:     &sent,
	}
}

func newMailLogListEngine(store domain.MailLogRepository, role domain.RoleName) *gin.Engine {
	engine := gin.New()
	engine.Use(withActor(role, ""))
	engine.GET("/settings/mail-logs", handlers.NewMailLogHandler(store).List)
	engine.GET("/settings/mail-logs/:id", handlers.NewMailLogHandler(store).Get)
	return engine
}

// TestMailLogList_EnvelopeShape membuktikan GET /settings/mail-logs menjawab
// 200 dengan amplop {items,total,page,limit} dan tiap baris memuat kunci
// kontrak (id,to,bcc,subject,template,status,attempts,error,createdAt,sentAt).
func TestMailLogList_EnvelopeShape(t *testing.T) {
	store := &stubMailLogStore{items: []domain.MailLog{cannedMailLog()}, total: 7}
	engine := newMailLogListEngine(store, domain.RoleSuperAdmin)

	rec := serve(engine, "GET", "/settings/mail-logs?page=2&limit=2", nil, "")
	mustStatus(t, rec, http.StatusOK)
	env := mustSuccess(t, rec)

	page := decodeData[struct {
		Items []map[string]any `json:"items"`
		Total int64            `json:"total"`
		Page  int              `json:"page"`
		Limit int              `json:"limit"`
	}](t, env)
	if page.Total != 7 || page.Page != 2 || page.Limit != 2 {
		t.Fatalf("got total=%d page=%d limit=%d, want 7/2/2", page.Total, page.Page, page.Limit)
	}
	if len(page.Items) != 1 {
		t.Fatalf("got %d items, want 1", len(page.Items))
	}
	item := page.Items[0]
	for _, key := range []string{"id", "to", "bcc", "subject", "template", "status", "attempts", "error", "createdAt", "sentAt"} {
		if _, ok := item[key]; !ok {
			t.Fatalf("baris verdict kehilangan kunci %q: %v", key, item)
		}
	}
	if item["status"] != "failed" || item["template"] != "visit_approved" {
		t.Fatalf("baris = %v, want status failed template visit_approved", item)
	}
	if bcc, ok := item["bcc"].([]any); !ok || len(bcc) != 1 || bcc[0] != "bos@thc.id" {
		t.Fatalf("baris bcc = %v, want [bos@thc.id]", item["bcc"])
	}
	if store.last.Page != 2 || store.last.Limit != 2 {
		t.Fatalf("store dapat page=%d limit=%d, want 2/2", store.last.Page, store.last.Limit)
	}
}

// TestMailLogList_StatusFilterReachesStore membuktikan ?status= diteruskan
// ke store dan default limit mengikuti kontrak notifikasi (20).
func TestMailLogList_StatusFilterReachesStore(t *testing.T) {
	store := &stubMailLogStore{items: []domain.MailLog{cannedMailLog()}, total: 1}
	engine := newMailLogListEngine(store, domain.RoleSuperAdmin)

	rec := serve(engine, "GET", "/settings/mail-logs?status=sent", nil, "")
	mustStatus(t, rec, http.StatusOK)
	if store.last.Status == nil || *store.last.Status != domain.MailLogSent {
		t.Fatalf("store dapat status=%v, want sent", store.last.Status)
	}
	if store.last.Limit != domain.DefaultMailLogPageSize {
		t.Fatalf("store dapat limit=%d, want default %d", store.last.Limit, domain.DefaultMailLogPageSize)
	}
}

// TestMailLogList_RejectsUnknownStatus membuktikan status asing dijawab 400
// VALIDATION_ERROR, bukan listing diam-diam.
func TestMailLogList_RejectsUnknownStatus(t *testing.T) {
	store := &stubMailLogStore{items: []domain.MailLog{cannedMailLog()}, total: 1}
	engine := newMailLogListEngine(store, domain.RoleSuperAdmin)

	rec := serve(engine, "GET", "/settings/mail-logs?status=dropped", nil, "")
	mustStatus(t, rec, http.StatusBadRequest)
	env := decodeEnvelope(t, rec)
	if env.Success || env.Error == nil || env.Error.Code != "VALIDATION_ERROR" {
		t.Fatalf("amplop 400 = %+v, want kode VALIDATION_ERROR", env.Error)
	}
}

// TestMailLogList_ClampsLimit membuktikan limit raksasa dipangkas ke 100.
func TestMailLogList_ClampsLimit(t *testing.T) {
	store := &stubMailLogStore{items: []domain.MailLog{cannedMailLog()}, total: 1}
	engine := newMailLogListEngine(store, domain.RoleSuperAdmin)

	rec := serve(engine, "GET", "/settings/mail-logs?limit=5000", nil, "")
	mustStatus(t, rec, http.StatusOK)
	env := mustSuccess(t, rec)
	limit := decodeData[struct {
		Limit int `json:"limit"`
	}](t, env)
	if limit.Limit != domain.MaxMailLogPageSize {
		t.Fatalf("limit = %d, want %d", limit.Limit, domain.MaxMailLogPageSize)
	}
	if store.last.Limit != domain.MaxMailLogPageSize {
		t.Fatalf("store dapat limit=%d, want %d", store.last.Limit, domain.MaxMailLogPageSize)
	}
}

// TestMailLogGet_DetailShape membuktikan GET /:id menjawab 200 dengan baris
// yang sama plus textBody.
func TestMailLogGet_DetailShape(t *testing.T) {
	body := "Permintaan VST-1 telah disetujui."
	row := cannedMailLog()
	row.TextBody = &body
	store := &stubMailLogStore{byID: map[string]domain.MailLog{"11111111-2222-3333-4444-555555555555": row}}
	engine := newMailLogListEngine(store, domain.RoleSuperAdmin)

	rec := serve(engine, "GET", "/settings/mail-logs/11111111-2222-3333-4444-555555555555", nil, "")
	mustStatus(t, rec, http.StatusOK)
	item := decodeData[map[string]any](t, mustSuccess(t, rec))
	if item["id"] != "11111111-2222-3333-4444-555555555555" || item["textBody"] != body {
		t.Fatalf("detail = %v, want id log-1 + textBody", item)
	}
}

// TestMailLogGet_InvalidAndMissing membuktikan id tak-parsable 400 dan id
// asing 404 NOT_FOUND.
func TestMailLogGet_InvalidAndMissing(t *testing.T) {
	store := &stubMailLogStore{byID: map[string]domain.MailLog{}}
	engine := newMailLogListEngine(store, domain.RoleSuperAdmin)

	rec := serve(engine, "GET", "/settings/mail-logs/bukan-uuid", nil, "")
	mustStatus(t, rec, http.StatusBadRequest)

	rec = serve(engine, "GET", "/settings/mail-logs/11111111-1111-1111-1111-111111111111", nil, "")
	mustStatus(t, rec, http.StatusNotFound)
	env := decodeEnvelope(t, rec)
	if env.Success || env.Error == nil || env.Error.Code != "NOT_FOUND" {
		t.Fatalf("amplop 404 = %+v, want kode NOT_FOUND", env.Error)
	}
}

// TestMailLog_RoleGate membuktikan super_admin dan dev-superadmin lolos di
// kedua endpoint, admin/security/vendor 403, dan anonim 401.
func TestMailLog_RoleGate(t *testing.T) {
	for _, role := range []domain.RoleName{domain.RoleSuperAdmin, domain.RoleDevSuperAdmin} {
		engine := newMailLogListEngine(&stubMailLogStore{items: []domain.MailLog{cannedMailLog()}, total: 1}, role)
		if rec := serve(engine, "GET", "/settings/mail-logs", nil, ""); rec.Code != http.StatusOK {
			t.Fatalf("GET role %s: status = %d, want 200", role, rec.Code)
		}
	}
	for _, role := range []domain.RoleName{domain.RoleAdmin, domain.RoleSecurity, domain.RoleVendor} {
		engine := newMailLogListEngine(&stubMailLogStore{items: []domain.MailLog{cannedMailLog()}, total: 1}, role)
		if rec := serve(engine, "GET", "/settings/mail-logs", nil, ""); rec.Code != http.StatusForbidden {
			t.Fatalf("GET role %s: status = %d, want 403", role, rec.Code)
		}
		detail := newMailLogListEngine(&stubMailLogStore{byID: map[string]domain.MailLog{"11111111-2222-3333-4444-555555555555": cannedMailLog()}}, role)
		if rec := serve(detail, "GET", "/settings/mail-logs/11111111-2222-3333-4444-555555555555", nil, ""); rec.Code != http.StatusForbidden {
			t.Fatalf("GET detail role %s: status = %d, want 403", role, rec.Code)
		}
	}

	anon := gin.New()
	anon.GET("/settings/mail-logs", handlers.NewMailLogHandler(&stubMailLogStore{}).List)
	anon.GET("/settings/mail-logs/:id", handlers.NewMailLogHandler(&stubMailLogStore{}).Get)
	if rec := serve(anon, "GET", "/settings/mail-logs", nil, ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("GET anonim: status = %d, want 401", rec.Code)
	}
	if rec := serve(anon, "GET", "/settings/mail-logs/11111111-2222-3333-4444-555555555555", nil, ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("GET detail anonim: status = %d, want 401", rec.Code)
	}
}

// TestMailLog_RouterWiring membuktikan kedua rute terdaftar pada path produksi
// di belakang rantai SuperAdminOnly yang asli: anonim 401, vendor 403,
// super_admin dan dev-superadmin 200.
func TestMailLog_RouterWiring(t *testing.T) {
	store := &stubMailLogStore{
		items: []domain.MailLog{cannedMailLog()},
		total: 1,
		byID:  map[string]domain.MailLog{"11111111-2222-3333-4444-555555555555": cannedMailLog()},
	}
	h := handlers.NewMailLogHandler(store)
	engine := deliveryhttp.New(deliveryhttp.Deps{
		Settings: deliveryhttp.SettingsRoutes{MailLogs: h.List, MailLogDetail: h.Get},
		Chain: deliveryhttp.Chain{
			Authenticate: func(c *gin.Context) {
				if role := c.GetHeader("X-Test-Role"); role != "" {
					deliveryhttp.WithIdentity(c, deliveryhttp.Identity{UserID: "actor-1", Role: domain.RoleName(role)})
				}
				c.Next()
			},
			SuperAdminOnly: middleware.RequireSuperAdmin(),
		},
	})

	serveAt := func(role, path string) int {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		if role != "" {
			req.Header.Set("X-Test-Role", role)
		}
		rec := httptest.NewRecorder()
		engine.ServeHTTP(rec, req)
		return rec.Code
	}
	if code := serveAt("", "/api/v1/settings/mail-logs"); code != http.StatusUnauthorized {
		t.Fatalf("GET anonim: status = %d, want 401", code)
	}
	if code := serveAt("vendor", "/api/v1/settings/mail-logs"); code != http.StatusForbidden {
		t.Fatalf("GET vendor: status = %d, want 403", code)
	}
	if code := serveAt("super_admin", "/api/v1/settings/mail-logs"); code != http.StatusOK {
		t.Fatalf("GET super_admin: status = %d, want 200", code)
	}
	if code := serveAt("dev-superadmin", "/api/v1/settings/mail-logs"); code != http.StatusOK {
		t.Fatalf("GET dev-superadmin: status = %d, want 200", code)
	}
	if code := serveAt("super_admin", "/api/v1/settings/mail-logs/11111111-2222-3333-4444-555555555555"); code != http.StatusOK {
		t.Fatalf("GET detail super_admin: status = %d, want 200", code)
	}
}
