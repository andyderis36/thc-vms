package handlers

import (
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/response"
	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/visit"
)

// Approve serves POST /visits/{id}/approve. Notes are optional.
func (h *VisitHandler) Approve(c *gin.Context) {
	actor, id, ok := h.mutationTarget(c)
	if !ok {
		return
	}
	var body struct {
		Notes string `json:"notes"`
	}
	if !bindJSON(c, &body) {
		return
	}
	if err := h.visits.Approve(c.Request.Context(), actor, id, body.Notes); err != nil {
		response.Fail(c, err)
		return
	}
	response.OK[any](c, nil)
}

// Reject serves POST /visits/{id}/reject. The reason is required with
// minLength 5 per the openapi schema; shorter is a 400 here.
func (h *VisitHandler) Reject(c *gin.Context) {
	actor, id, ok := h.mutationTarget(c)
	if !ok {
		return
	}
	var body struct {
		Reason string `json:"reason"`
	}
	if !bindJSON(c, &body) {
		return
	}
	reason := strings.TrimSpace(body.Reason)
	if len([]rune(reason)) < 5 {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Alasan penolakan minimal 5 karakter.")
		return
	}
	if err := h.visits.Reject(c.Request.Context(), actor, id, reason); err != nil {
		response.Fail(c, err)
		return
	}
	response.OK[any](c, nil)
}

// Reschedule serves POST /visits/{id}/reschedule. start_date, end_date and
// reason are all required; any missing member is a 400.
func (h *VisitHandler) Reschedule(c *gin.Context) {
	actor, id, ok := h.mutationTarget(c)
	if !ok {
		return
	}
	var body struct {
		StartDate string `json:"start_date"`
		EndDate   string `json:"end_date"`
		Reason    string `json:"reason"`
	}
	if !bindJSON(c, &body) {
		return
	}
	if strings.TrimSpace(body.StartDate) == "" || strings.TrimSpace(body.EndDate) == "" || strings.TrimSpace(body.Reason) == "" {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Tanggal mulai, tanggal selesai, dan alasan penjadwalan ulang wajib diisi.")
		return
	}
	start, err := time.Parse(time.RFC3339, body.StartDate)
	if err != nil {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Tanggal mulai kunjungan tidak valid.")
		return
	}
	end, err := time.Parse(time.RFC3339, body.EndDate)
	if err != nil {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Tanggal selesai kunjungan tidak valid.")
		return
	}
	if err := h.visits.Reschedule(c.Request.Context(), actor, id, start, end, strings.TrimSpace(body.Reason)); err != nil {
		response.Fail(c, err)
		return
	}
	response.OK[any](c, nil)
}

// mutationTarget resolves the actor and the visit uuid for the four
// state-changing edges. A VST- code is translated through GetVisit first so
// the manual-scan path works everywhere, not just on reads.
func (h *VisitHandler) mutationTarget(c *gin.Context) (visit.Actor, domain.UUID, bool) {
	actor, err := visitActor(c)
	if err != nil {
		response.Fail(c, err)
		return visit.Actor{}, "", false
	}
	key := strings.TrimSpace(c.Param("id"))
	if key == "" {
		response.Fail(c, domain.NotFoundEntity("Kunjungan"))
		return visit.Actor{}, "", false
	}
	if !strings.HasPrefix(key, "VST-") {
		return actor, domain.UUID(key), true
	}
	found, err := h.visits.GetVisit(c.Request.Context(), actor, key)
	if err != nil {
		response.Fail(c, err)
		return visit.Actor{}, "", false
	}
	return actor, found.ID, true
}
