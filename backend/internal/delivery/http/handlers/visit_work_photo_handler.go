package handlers

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"thc-vms/backend/internal/delivery/http/response"
	"thc-vms/backend/internal/domain"
)

// AttachWorkPhoto serves POST /visits/:id/work-photos. The body carries the
// proof kind ("before"|"after"), the stored file URL returned by POST
// /uploads with the work_photos category, and the optional visit_log_id that
// binds the proof to one check-in/out cycle (absent = the latest 'in' log,
// resolved server-side). A missing kind or url is a 400 here; an unknown
// kind, an untrusted URL, or a foreign log id is a 422 from the usecase.
// The usecase owns the scope (owning vendor, visit creator, visiting-only
// gate), so its refusals project through response.Fail (404/403/409/...). A
// first attach answers 201 with the stored proof, a re-attach answers 200
// with the replaced proof.
func (h *VisitHandler) AttachWorkPhoto(c *gin.Context) {
	actor, id, ok := h.mutationTarget(c)
	if !ok {
		return
	}
	var body struct {
		Kind       string  `json:"kind"`
		URL        string  `json:"url"`
		VisitLogID *string `json:"visit_log_id"`
	}
	if !bindJSON(c, &body) {
		return
	}
	if strings.TrimSpace(body.Kind) == "" || strings.TrimSpace(body.URL) == "" {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Jenis dan URL bukti pengerjaan wajib diisi.")
		return
	}
	var visitLogID *domain.UUID
	if body.VisitLogID != nil && strings.TrimSpace(*body.VisitLogID) != "" {
		parsed, err := uuid.Parse(strings.TrimSpace(*body.VisitLogID))
		if err != nil {
			response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Siklus kunjungan (visit_log_id) tidak valid.")
			return
		}
		converted := domain.UUID(parsed.String())
		visitLogID = &converted
	}
	photo, created, err := h.visits.AttachWorkPhoto(c.Request.Context(), actor, id, body.Kind, body.URL, visitLogID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	if created {
		response.Created(c, toAttachedWorkPhoto(photo))
		return
	}
	response.OK(c, toAttachedWorkPhoto(photo))
}
