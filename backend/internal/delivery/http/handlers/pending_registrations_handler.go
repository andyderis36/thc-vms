package handlers

import (
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/response"
	"thc-vms/backend/internal/domain"
)

// PendingRegistrationHandler serves the superadmin registration queue read
// (GET /notifications/pending-registrations). It maps HTTP straight onto the
// domain.VendorRegistrationNoticeRepository port owned by migration 000020:
// the Wave-1 adapter implements it, the handler codes against the port so
// both sides reconcile without touching this file. Every answer goes through
// the response envelope; no handler invents a key.
type PendingRegistrationHandler struct {
	notices domain.VendorRegistrationNoticeRepository
}

// NewPendingRegistrationHandler wires the handler to the registration-queue
// port. A nil port answers 500 (hermetic mounts and the pre-adapter boot);
// production passes the repository adapter.
func NewPendingRegistrationHandler(notices domain.VendorRegistrationNoticeRepository) *PendingRegistrationHandler {
	return &PendingRegistrationHandler{notices: notices}
}

// pendingRegistrationDTO mirrors the openapi PendingRegistrationItem shape:
// the pending vendor account joined onto its queue row, so the approval
// screen renders without a second hop.
type pendingRegistrationDTO struct {
	VendorUserID string `json:"vendor_user_id"`
	Name         string `json:"name"`
	Email        string `json:"email"`
	Phone        string `json:"phone"`
	NIK          string `json:"nik"`
	VendorName   string `json:"vendor_name"`
	CreatedAt    string `json:"created_at"`
	Status       string `json:"status"`
}

// pendingRegistrationListDTO mirrors the openapi
// PendingRegistrationListResponse data object: the page plus the companion
// bell count. It is never a bare array.
type pendingRegistrationListDTO struct {
	Items        []pendingRegistrationDTO `json:"items"`
	Total        int64                    `json:"total"`
	PendingCount int64                    `json:"pending_count"`
	Page         int                      `json:"page"`
	Limit        int                      `json:"limit"`
}

// toPendingRegistration projects one queue row onto the wire shape.
func toPendingRegistration(item domain.PendingVendorRegistration) pendingRegistrationDTO {
	return pendingRegistrationDTO{
		VendorUserID: string(item.VendorUserID),
		Name:         item.Name,
		Email:        item.Email,
		Phone:        item.Phone,
		NIK:          item.NIK,
		VendorName:   item.VendorName,
		CreatedAt:    item.CreatedAt.Format(time.RFC3339),
		Status:       string(item.Status),
	}
}

// List serves GET /notifications/pending-registrations with 200: the newest
// pending rows first with the companion bell count. The feed is global by
// design (the queue is the superadmin console's own backlog), so a
// location_id filter is refused with 400 instead of silently narrowing or
// widening anything. Page and limit fall back to the openapi 1/20 defaults;
// the limit is capped at the notification page ceiling so one page can never
// dump the queue.
func (h *PendingRegistrationHandler) List(c *gin.Context) {
	if _, ok := requireSuperAdmin(c); !ok {
		return
	}
	if h.notices == nil {
		response.Fail(c, domain.ErrDatabase)
		return
	}
	if strings.TrimSpace(c.Query("location_id")) != "" {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Filter location_id tidak didukung pada antre ini.")
		return
	}
	page := queryInt(c.Query("page"), 1)
	limit := queryInt(c.Query("limit"), 20)
	if limit > domain.MaxNotificationPageSize {
		limit = domain.MaxNotificationPageSize
	}
	items, total, pendingCount, err := h.notices.ListPending(c.Request.Context(), page, limit)
	if err != nil {
		response.Fail(c, err)
		return
	}
	rows := make([]pendingRegistrationDTO, 0, len(items))
	for _, item := range items {
		rows = append(rows, toPendingRegistration(item))
	}
	response.OK(c, pendingRegistrationListDTO{
		Items:        rows,
		Total:        total,
		PendingCount: pendingCount,
		Page:         page,
		Limit:        limit,
	})
}
