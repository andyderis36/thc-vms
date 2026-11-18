package handlers_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/handlers"
	"thc-vms/backend/internal/domain"
)

func newCompleteEngine(svc *fakeGateService) *gin.Engine {
	engine := gin.New()
	engine.Use(withActor(domain.RoleAdmin, "loc-A"))
	h := handlers.NewGateHandler(svc)
	engine.POST("/visits/:id/complete", h.Complete)
	return engine
}

func newLogsEngine(svc *fakeVisitService, reader *fakeVisitLogReader) *gin.Engine {
	engine := gin.New()
	engine.Use(withActor(domain.RoleAdmin, "loc-A"))
	h := handlers.NewVisitHandler(svc).WithLogs(reader)
	engine.GET("/visits/:id/logs", h.Logs)
	return engine
}

func TestComplete_Success(t *testing.T) {
	svc := &fakeGateService{}
	rec := serve(newCompleteEngine(svc), http.MethodPost, "/visits/visit-1/complete", nil, "")
	mustStatus(t, rec, 200)
	mustSuccess(t, rec)
	if string(svc.lastCompleteID) != "visit-1" {
		t.Fatalf("complete id = %q, want visit-1", svc.lastCompleteID)
	}
}

func TestComplete_ForbiddenRole(t *testing.T) {
	svc := &fakeGateService{completeErr: domain.Forbidden("Hanya admin atau super_admin yang dapat menyelesaikan kunjungan.")}
	rec := serve(newCompleteEngine(svc), http.MethodPost, "/visits/visit-1/complete", nil, "")
	mustStatus(t, rec, 403)
	env := decodeEnvelope(t, rec)
	if env.Success || env.Error == nil || env.Error.Code != "FORBIDDEN" {
		t.Fatalf("expected FORBIDDEN failure envelope, got %q", rec.Body.String())
	}
}

func TestComplete_OffBranch(t *testing.T) {
	svc := &fakeGateService{completeErr: domain.ForbiddenBranch()}
	rec := serve(newCompleteEngine(svc), http.MethodPost, "/visits/visit-1/complete", nil, "")
	mustStatus(t, rec, 403)
	env := decodeEnvelope(t, rec)
	if env.Success || env.Error == nil || env.Error.Code != "FORBIDDEN_BRANCH" {
		t.Fatalf("expected FORBIDDEN_BRANCH failure envelope, got %q", rec.Body.String())
	}
}

func TestLogs_ListOldestFirstWithEnrichedActor(t *testing.T) {
	first := time.Date(2026, time.October, 1, 9, 0, 0, 0, time.UTC)
	second := first.Add(time.Hour)
	reader := &fakeVisitLogReader{items: []handlers.VisitLogDTO{
		{
			ID: "log-1", VisitRequestID: "visit-1", Direction: "in",
			ActorUserID: strPtr("actor-1"), ActorRole: strPtr("security"),
			ActorName: strPtr("Satpam"), CreatedAt: first.Format(time.RFC3339Nano),
		},
		{
			ID: "log-2", VisitRequestID: "visit-1", Direction: "out",
			ActorUserID: strPtr("actor-1"), ActorRole: strPtr("security"),
			ActorName: strPtr("Satpam"), CreatedAt: second.Format(time.RFC3339Nano),
		},
	}}
	svc := &fakeVisitService{visitByKey: map[string]domain.VisitRequest{
		"VST-0000000001": cannedVisit(),
	}}
	rec := serve(newLogsEngine(svc, reader), http.MethodGet, "/visits/VST-0000000001/logs", nil, "")
	mustStatus(t, rec, 200)
	env := mustSuccess(t, rec)
	items := decodeData[[]handlers.VisitLogDTO](t, env)
	if len(items) != 2 {
		t.Fatalf("logs = %d rows, want 2: %q", len(items), rec.Body.String())
	}
	if items[0].ID != "log-1" || items[1].ID != "log-2" {
		t.Fatalf("order = %q,%q, want oldest-first log-1,log-2", items[0].ID, items[1].ID)
	}
	if items[0].Direction != "in" || items[1].Direction != "out" {
		t.Fatalf("directions = %q,%q, want in,out", items[0].Direction, items[1].Direction)
	}
	if items[0].ActorName == nil || *items[0].ActorName != "Satpam" {
		t.Fatalf("actor_name = %v, want Satpam", items[0].ActorName)
	}
	// The reader must receive the resolved visit id, not the VST- code key.
	if string(reader.last) != "visit-1" {
		t.Fatalf("reader visit id = %q, want visit-1", reader.last)
	}
}

func TestLogs_EmptyIsArrayNot404(t *testing.T) {
	reader := &fakeVisitLogReader{items: []handlers.VisitLogDTO{}}
	rec := serve(newLogsEngine(&fakeVisitService{}, reader), http.MethodGet, "/visits/visit-1/logs", nil, "")
	mustStatus(t, rec, 200)
	env := mustSuccess(t, rec)
	if string(env.Data) != "[]" {
		t.Fatalf("empty data = %q, want []", string(env.Data))
	}
}

func TestLogs_ForbiddenVisitIsNotRead(t *testing.T) {
	reader := &fakeVisitLogReader{}
	svc := &fakeVisitService{getErr: domain.ForbiddenBranch()}
	rec := serve(newLogsEngine(svc, reader), http.MethodGet, "/visits/visit-1/logs", nil, "")
	mustStatus(t, rec, 403)
	env := decodeEnvelope(t, rec)
	if env.Success || env.Error == nil || env.Error.Code != "FORBIDDEN_BRANCH" {
		t.Fatalf("expected FORBIDDEN_BRANCH failure envelope, got %q", rec.Body.String())
	}
	if reader.last != "" {
		t.Fatalf("log reader must not run for an out-of-scope visit, got %q", reader.last)
	}
}
