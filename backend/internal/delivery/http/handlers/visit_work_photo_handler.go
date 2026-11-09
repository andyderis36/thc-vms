package handlers

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/response"
)

// AttachWorkPhoto serves POST /visits/:id/work-photos. The body carries the
// proof kind ("before"|"after") and the stored file URL returned by
// POST /uploads with the work_photos category. A missing kind or url is a
// 400 here; an unknown kind or an untrusted URL is a 422 from the usecase.
// The usecase owns the scope (owning vendor, branch admin/security,
// super_admin) and the visiting-only gate, so its refusals project through
// response.Fail (404/403/409/...). A first attach answers 201 with the
// stored proof, a re-attach answers 200 with the replaced proof.
func (h *VisitHandler) AttachWorkPhoto(c *gin.Context) {
	actor, id, ok := h.mutationTarget(c)
	if !ok {
		return
	}
	var body struct {
		Kind string `json:"kind"`
		URL  string `json:"url"`
	}
	if !bindJSON(c, &body) {
		return
	}
	if strings.TrimSpace(body.Kind) == "" || strings.TrimSpace(body.URL) == "" {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Jenis dan URL bukti pengerjaan wajib diisi.")
		return
	}
	photo, created, err := h.visits.AttachWorkPhoto(c.Request.Context(), actor, id, body.Kind, body.URL)
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
