package handlers

import (
	"context"
	"strings"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/response"
	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/gate"
)

// GateService is the gate port this handler drives. *gate.Service satisfies
// it implicitly, so production wires the real service and tests wire a
// hand-written fake; no mocking library is involved.
type GateService interface {
	CheckIn(ctx context.Context, actor gate.Actor, visitIDOrCode string, in gate.CheckInInput) (domain.CheckIn, error)
	CheckOut(ctx context.Context, actor gate.Actor, visitID domain.UUID) (domain.CheckOut, error)
}

// Compile-time proof that the production service wires into the handler.
var _ GateService = (*gate.Service)(nil)

// GateHandler serves the security-gate operations (SCR-05 triple-mode
// scanner: live camera, gallery upload, or manual code entry all arrive here
// as either a uuid or a VST- code). It only maps HTTP onto the usecase.
type GateHandler struct {
	gate GateService
}

// NewGateHandler wires the handler to its usecase port.
func NewGateHandler(svc GateService) *GateHandler {
	return &GateHandler{gate: svc}
}

// CheckIn serves POST /visits/{id}/checkin. photo_url, badge_code and notes
// are ALL optional: the flow diagram has no photo step, so a photo is never
// a precondition. A window violation surfaces as 400 with the mandated
// message, a role/branch violation as 403, both via response.Fail.
func (h *GateHandler) CheckIn(c *gin.Context) {
	actor, err := gateActor(c)
	if err != nil {
		response.Fail(c, err)
		return
	}
	var body struct {
		PhotoURL  *string `json:"photo_url"`
		BadgeCode *string `json:"badge_code"`
		Notes     string  `json:"notes"`
	}
	if !bindJSON(c, &body) {
		return
	}
	key := strings.TrimSpace(c.Param("id"))
	if key == "" {
		response.Fail(c, domain.NotFoundEntity("Kunjungan"))
		return
	}
	if _, err := h.gate.CheckIn(c.Request.Context(), actor, key, gate.CheckInInput{
		PhotoURL:  body.PhotoURL,
		BadgeCode: body.BadgeCode,
		Notes:     body.Notes,
	}); err != nil {
		response.Fail(c, err)
		return
	}
	response.OK[any](c, nil)
}

// CheckOut serves POST /visits/{id}/checkout. A double checkout surfaces as
// a conflict (409) from the usecase via response.Fail.
func (h *GateHandler) CheckOut(c *gin.Context) {
	actor, err := gateActor(c)
	if err != nil {
		response.Fail(c, err)
		return
	}
	key := strings.TrimSpace(c.Param("id"))
	if key == "" {
		response.Fail(c, domain.NotFoundEntity("Kunjungan"))
		return
	}
	if _, err := h.gate.CheckOut(c.Request.Context(), actor, domain.UUID(key)); err != nil {
		response.Fail(c, err)
		return
	}
	response.OK[any](c, nil)
}
