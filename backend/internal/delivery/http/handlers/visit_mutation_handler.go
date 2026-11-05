package handlers

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/response"
	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/visit"
	"thc-vms/backend/internal/validation"
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
	if validation.RuneLen(strings.TrimSpace(body.Notes)) > validation.TextMaxLength {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Catatan persetujuan maksimal "+strconv.Itoa(validation.TextMaxLength)+" karakter.")
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
	if validation.RuneLen(reason) < validation.RejectReasonMinLength {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Alasan penolakan minimal "+strconv.Itoa(validation.RejectReasonMinLength)+" karakter.")
		return
	}
	if validation.RuneLen(reason) > validation.TextMaxLength {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Alasan penolakan maksimal "+strconv.Itoa(validation.TextMaxLength)+" karakter.")
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
	reason := strings.TrimSpace(body.Reason)
	if validation.RuneLen(reason) > validation.TextMaxLength {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Alasan penjadwalan ulang maksimal "+strconv.Itoa(validation.TextMaxLength)+" karakter.")
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
	if err := h.visits.Reschedule(c.Request.Context(), actor, id, start, end, reason); err != nil {
		response.Fail(c, err)
		return
	}
	response.OK[any](c, nil)
}

// UpdateVisitorContact serves PATCH /visits/{id}/visitors/{visitorId}. The
// body carries the new phone number; a sent id_number is refused by the
// usecase. Only the owning vendor may correct its members (creator-only);
// everyone else answers 404. Answers 200 with the corrected VisitorItem,
// including the persistent phone_edited marker.
func (h *VisitHandler) UpdateVisitorContact(c *gin.Context) {
	actor, visitID, ok := h.mutationTarget(c)
	if !ok {
		return
	}
	memberKey := strings.TrimSpace(c.Param("visitorId"))
	if memberKey == "" {
		response.Fail(c, domain.NotFoundEntity("Kunjungan"))
		return
	}
	var body struct {
		Phone    *string `json:"phone"`
		IDNumber *string `json:"id_number"`
	}
	if !bindJSON(c, &body) {
		return
	}
	updated, err := h.visits.UpdateVisitorContact(c.Request.Context(), actor, visitID, domain.UUID(memberKey), body.Phone, body.IDNumber)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, toVisitorDTO(updated))
}

// mutationTarget resolves the actor and the visit uuid for the state-changing
// edges. A VST- code is translated through GetVisit first so
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
