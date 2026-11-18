package handlers

import (
	"context"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"thc-vms/backend/internal/delivery/http/response"
	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/repository/db"
	"thc-vms/backend/internal/validation"
)

// VisitLogDTO is the wire shape of one gate-entry row. It mirrors the
// frontend VisitLog contract: actor_name is optional enrichment and stays
// absent when the actor cannot be resolved.
type VisitLogDTO struct {
	ID             string  `json:"id"`
	VisitRequestID string  `json:"visit_request_id"`
	Direction      string  `json:"direction"`
	ActorUserID    *string `json:"actor_user_id"`
	ActorRole      *string `json:"actor_role"`
	ActorName      *string `json:"actor_name,omitempty"`
	CreatedAt      string  `json:"created_at"`
}

// VisitLogReader is the read port for the per-entry gate timeline.
type VisitLogReader interface {
	ListVisitLogsByVisit(ctx context.Context, visitID domain.UUID) ([]VisitLogDTO, error)
}

// dbVisitLogReader adapts the generated sqlc queries to VisitLogReader.
type dbVisitLogReader struct {
	q *db.Queries
}

// NewDBVisitLogReader wires the production sqlc reader into the handler.
func NewDBVisitLogReader(q *db.Queries) VisitLogReader {
	return &dbVisitLogReader{q: q}
}

func (r *dbVisitLogReader) ListVisitLogsByVisit(ctx context.Context, visitID domain.UUID) ([]VisitLogDTO, error) {
	parsed, err := uuid.Parse(string(visitID))
	if err != nil {
		return nil, err
	}
	rows, err := r.q.ListVisitLogsByVisit(ctx, db.ListVisitLogsByVisitParams{VisitRequestID: parsed})
	if err != nil {
		return nil, err
	}
	names := make(map[uuid.UUID]*string)
	out := make([]VisitLogDTO, 0, len(rows))
	for _, row := range rows {
		item := VisitLogDTO{
			ID:             row.ID.String(),
			VisitRequestID: row.VisitRequestID.String(),
			Direction:      row.Direction,
			CreatedAt:      row.CreatedAt.UTC().Format(time.RFC3339Nano),
		}
		if row.ActorUserID.Valid {
			s := uuid.UUID(row.ActorUserID.Bytes).String()
			item.ActorUserID = &s
		}
		if row.ActorRole.Valid {
			s := row.ActorRole.String
			item.ActorRole = &s
		}
		if row.ActorUserID.Valid {
			id := uuid.UUID(row.ActorUserID.Bytes)
			name, seen := names[id]
			if !seen {
				name = resolveActorName(ctx, r.q, id)
				names[id] = name
			}
			item.ActorName = name
		}
		out = append(out, item)
	}
	return out, nil
}

// resolveActorName is the handler-side equivalent of the repository's
// resolveUserDisplay: a missing row or a lookup error yields nil so the client
// falls back to actor_role, which is the documented frontend behaviour.
func resolveActorName(ctx context.Context, q *db.Queries, id uuid.UUID) *string {
	row, err := q.GetUserByID(ctx, db.GetUserByIDParams{ID: id})
	if err != nil {
		return nil
	}
	name := strings.TrimSpace(row.Name)
	if name == "" {
		return nil
	}
	return &name
}

// Logs serves GET /visits/{id}/logs. It reuses GetVisit as the authorization
// gate so the branch/vendor/superadmin scope is exactly the visits detail
// read; only after that succeeds does it read the entry timeline. An empty
// timeline answers [] rather than 404.
func (h *VisitHandler) Logs(c *gin.Context) {
	actor, err := visitActor(c)
	if err != nil {
		response.Fail(c, err)
		return
	}
	key := strings.TrimSpace(c.Param("id"))
	if key == "" || validation.RuneLen(key) > validation.VisitIDInputMaxLength {
		response.Fail(c, domain.NotFoundEntity("Kunjungan"))
		return
	}
	found, err := h.visits.GetVisit(c.Request.Context(), actor, key)
	if err != nil {
		response.Fail(c, err)
		return
	}
	logs, err := h.logs.ListVisitLogsByVisit(c.Request.Context(), found.ID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, logs)
}
