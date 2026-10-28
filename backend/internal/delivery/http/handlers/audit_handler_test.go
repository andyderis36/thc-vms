package handlers_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/handlers"
	"thc-vms/backend/internal/domain"
)

// stubAuditStore is a hand-written fake for domain.AuditRepository: it serves
// a canned trail page and records the last filter so the filter/pagination
// mapping is pinned.
type stubAuditStore struct {
	items []domain.AuditLog
	total int64
	err   error
	last  domain.AuditFilter
}

func (s *stubAuditStore) Append(_ context.Context, entry domain.AuditEntry) (domain.AuditLog, error) {
	return domain.AuditLog{Action: entry.Action, Entity: entry.Entity}, nil
}

func (s *stubAuditStore) List(_ context.Context, filter domain.AuditFilter) ([]domain.AuditLog, int64, error) {
	s.last = filter
	if s.err != nil {
		return nil, 0, s.err
	}
	return s.items, s.total, nil
}

func cannedAuditLog() domain.AuditLog {
	actor := domain.UUID("actor-1")
	entity := domain.UUID("target-1")
	return domain.AuditLog{
		ID:        "log-1",
		UserID:    &actor,
		Action:    domain.AuditActionUserCreate,
		Entity:    domain.AuditEntityUser,
		EntityID:  &entity,
		Timestamp: time.Date(2026, time.October, 5, 10, 0, 0, 0, time.UTC),
		IP:        "203.0.113.7",
		UserAgent: "AuditAgent/1.0",
		Metadata:  map[string]string{"email": "tek@vendor.local"},
	}
}

func newAuditListEngine(store domain.AuditRepository, role domain.RoleName) *gin.Engine {
	engine := gin.New()
	engine.Use(withActor(role, ""))
	engine.GET("/audit-logs", handlers.NewAuditHandler(store).List)
	return engine
}

func TestAuditList_SuperAdminSeesEnvelopeWithPagination(t *testing.T) {
	store := &stubAuditStore{items: []domain.AuditLog{cannedAuditLog()}, total: 42}
	engine := newAuditListEngine(store, domain.RoleSuperAdmin)

	rec := serve(engine, "GET", "/audit-logs?page=2&limit=2", nil, "")
	mustStatus(t, rec, http.StatusOK)
	env := mustSuccess(t, rec)

	var page struct {
		Items []map[string]any `json:"items"`
		Total int64            `json:"total"`
		Page  int              `json:"page"`
		Limit int              `json:"limit"`
	}
	if err := json.Unmarshal(env.Data, &page); err != nil {
		t.Fatalf("data is not the paginated trail: %v: %q", err, string(env.Data))
	}
	if page.Total != 42 || page.Page != 2 || page.Limit != 2 {
		t.Fatalf("got total=%d page=%d limit=%d, want 42/2/2", page.Total, page.Page, page.Limit)
	}
	if len(page.Items) != 1 {
		t.Fatalf("got %d items, want 1", len(page.Items))
	}
	item := page.Items[0]
	for _, key := range []string{"id", "action", "entity", "timestamp"} {
		if _, ok := item[key]; !ok {
			t.Fatalf("trail item misses key %q: %v", key, item)
		}
	}
	if item["action"] != domain.AuditActionUserCreate {
		t.Fatalf("action = %v, want %q", item["action"], domain.AuditActionUserCreate)
	}
	if store.last.Limit != 2 || store.last.Offset != 2 {
		t.Fatalf("store got limit=%d offset=%d, want 2/2", store.last.Limit, store.last.Offset)
	}
}

func TestAuditList_FilterReachesStore(t *testing.T) {
	store := &stubAuditStore{items: []domain.AuditLog{cannedAuditLog()}, total: 1}
	engine := newAuditListEngine(store, domain.RoleSuperAdmin)

	rec := serve(engine, "GET", "/audit-logs?action=user.create&entity=user&q=%20%20Audit%20Actor%20%20&order=ASC", nil, "")
	mustStatus(t, rec, http.StatusOK)
	if store.last.Action != domain.AuditActionUserCreate || store.last.Entity != domain.AuditEntityUser {
		t.Fatalf("store got action=%q entity=%q, want the query filters", store.last.Action, store.last.Entity)
	}
	if store.last.Q != "Audit Actor" || store.last.Order != "asc" {
		t.Fatalf("store got q=%q order=%q, want trimmed q and normalised asc", store.last.Q, store.last.Order)
	}
}

func TestAuditList_ClampsLimitAndEchoesNormalisedFilter(t *testing.T) {
	store := &stubAuditStore{items: []domain.AuditLog{cannedAuditLog()}, total: 1}
	engine := newAuditListEngine(store, domain.RoleSuperAdmin)

	rec := serve(engine, "GET", "/audit-logs?page=2&limit=5000&q=%20%20tek%20%20&order=bogus", nil, "")
	mustStatus(t, rec, http.StatusOK)
	env := mustSuccess(t, rec)

	var page struct {
		Page   int    `json:"page"`
		Limit  int    `json:"limit"`
		Offset int    `json:"offset"`
		Q      string `json:"q"`
		Order  string `json:"order"`
	}
	if err := json.Unmarshal(env.Data, &page); err != nil {
		t.Fatalf("data is not the paginated trail: %v: %q", err, string(env.Data))
	}
	if page.Page != 2 || page.Limit != 200 || page.Offset != 200 || page.Q != "tek" || page.Order != "desc" {
		t.Fatalf("echo = %+v, want page 2 limit 200 offset 200 q tek order desc", page)
	}
	if store.last.Limit != 200 || store.last.Offset != 200 || store.last.Q != "tek" || store.last.Order != "desc" {
		t.Fatalf("store got limit=%d offset=%d q=%q order=%q, want normalised values", store.last.Limit, store.last.Offset, store.last.Q, store.last.Order)
	}
}

func TestAuditList_DefaultLimitIsDomainDefault(t *testing.T) {
	store := &stubAuditStore{items: []domain.AuditLog{cannedAuditLog()}, total: 1}
	engine := newAuditListEngine(store, domain.RoleSuperAdmin)

	rec := serve(engine, "GET", "/audit-logs", nil, "")
	mustStatus(t, rec, http.StatusOK)
	env := mustSuccess(t, rec)

	var page struct {
		Limit  int    `json:"limit"`
		Offset int    `json:"offset"`
		Order  string `json:"order"`
	}
	if err := json.Unmarshal(env.Data, &page); err != nil {
		t.Fatalf("data is not the paginated trail: %v: %q", err, string(env.Data))
	}
	if page.Limit != 50 || page.Offset != 0 || page.Order != "desc" {
		t.Fatalf("defaults = %+v, want limit 50 offset 0 order desc", page)
	}
}

func TestAuditList_NonSuperAdminIsForbidden(t *testing.T) {
	for _, role := range []domain.RoleName{domain.RoleAdmin, domain.RoleSecurity, domain.RoleVendor} {
		store := &stubAuditStore{items: []domain.AuditLog{cannedAuditLog()}, total: 1}
		engine := newAuditListEngine(store, role)

		rec := serve(engine, "GET", "/audit-logs", nil, "")
		mustStatus(t, rec, http.StatusForbidden)
		env := decodeEnvelope(t, rec)
		if env.Success || env.Error == nil {
			t.Fatalf("role %s: want the failure envelope, got %q", role, rec.Body.String())
		}
	}
}

func TestAuditList_AnonymousIsUnauthorized(t *testing.T) {
	store := &stubAuditStore{items: []domain.AuditLog{cannedAuditLog()}, total: 1}
	engine := gin.New()
	engine.GET("/audit-logs", handlers.NewAuditHandler(store).List)

	rec := serve(engine, "GET", "/audit-logs", nil, "")
	mustStatus(t, rec, http.StatusUnauthorized)
}
