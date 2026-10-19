package handlers

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	deliveryhttp "thc-vms/backend/internal/delivery/http"
	"thc-vms/backend/internal/delivery/http/response"
	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/notification"
)

// NotificationService is the notification port this handler drives.
type NotificationService interface {
	List(ctx context.Context, actor notification.Actor, in notification.ListNotificationsInput) (notification.ListNotificationsResult, error)
	MarkRead(ctx context.Context, actor notification.Actor, id domain.UUID) error
	MarkAllRead(ctx context.Context, actor notification.Actor) (int64, error)
}

// Compile-time proof that the production service wires into the handler.
var _ NotificationService = (*notification.Service)(nil)

// NotificationHandler serves the notification endpoints.
type NotificationHandler struct {
	notifications NotificationService
}

// NewNotificationHandler wires the handler to its usecase port.
func NewNotificationHandler(svc NotificationService) *NotificationHandler {
	return &NotificationHandler{notifications: svc}
}

// notificationDTO mirrors the openapi Notification shape.
type notificationDTO struct {
	ID             string `json:"id"`
	Type           string `json:"type"`
	VisitRequestID string `json:"visit_request_id"`
	VisitID        string `json:"visit_id"`
	LocationID     string `json:"location_id"`
	LocationName   string `json:"location_name"`
	Title          string `json:"title"`
	Message        string `json:"message"`
	IsRead         bool   `json:"is_read"`
	OccurredAt     string `json:"occurred_at"`
}

// notificationListDTO mirrors the NotificationListResponse data object.
type notificationListDTO struct {
	Items       []notificationDTO `json:"items"`
	Total       int64             `json:"total"`
	UnreadCount int64             `json:"unread_count"`
	Page        int               `json:"page"`
	Limit       int               `json:"limit"`
}

// notificationMarkReadDTO mirrors the mark-read response data object.
type notificationMarkReadDTO struct {
	ID     string `json:"id"`
	IsRead bool   `json:"is_read"`
}

// notificationReadAllDTO mirrors the read-all response data object.
type notificationReadAllDTO struct {
	Updated int64 `json:"updated"`
}

// toNotification projects one domain notification onto the wire shape.
func toNotification(n domain.Notification) notificationDTO {
	return notificationDTO{
		ID:             string(n.ID),
		Type:           string(n.Type),
		VisitRequestID: string(n.VisitRequestID),
		VisitID:        n.VisitID,
		LocationID:     string(n.LocationID),
		LocationName:   n.LocationName,
		Title:          n.Title,
		Message:        n.Message,
		IsRead:         n.IsRead,
		OccurredAt:     n.OccurredAt.Format(time.RFC3339),
	}
}

// List serves GET /notifications.
func (h *NotificationHandler) List(c *gin.Context) {
	id, ok := requireNotificationRole(c)
	if !ok {
		return
	}
	if h.notifications == nil {
		response.Fail(c, domain.ErrDatabase)
		return
	}
	page := queryInt(c.Query("page"), 1)
	limit := queryInt(c.Query("limit"), 20)
	in := notification.ListNotificationsInput{Page: page, Limit: limit}
	if raw := strings.TrimSpace(c.Query("location_id")); raw != "" {
		parsed, err := domain.ParseUUID(raw)
		if err != nil {
			response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "location_id tidak valid.")
			return
		}
		in.LocationID = &parsed
	}
	actor := notification.Actor{ID: id.UserID, Role: id.Role, LocationID: id.LocationID}
	result, err := h.notifications.List(c.Request.Context(), actor, in)
	if err != nil {
		response.Fail(c, err)
		return
	}
	rows := make([]notificationDTO, 0, len(result.Items))
	for _, item := range result.Items {
		rows = append(rows, toNotification(item))
	}
	response.OK(c, notificationListDTO{
		Items:       rows,
		Total:       result.Total,
		UnreadCount: result.UnreadCount,
		Page:        result.Page,
		Limit:       result.Limit,
	})
}

// MarkRead serves PATCH /notifications/{id}: it marks one owned notification
// read. The body is optional; a present is_read must be true (unreading is not
// supported in the MVP). An unowned or missing id answers 404 through the
// usecase.
func (h *NotificationHandler) MarkRead(c *gin.Context) {
	id, ok := requireNotificationRole(c)
	if !ok {
		return
	}
	if h.notifications == nil {
		response.Fail(c, domain.ErrDatabase)
		return
	}
	parsed, err := domain.ParseUUID(c.Param("id"))
	if err != nil {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "ID notifikasi tidak valid.")
		return
	}
	var body struct {
		IsRead *bool `json:"is_read"`
	}
	if err := c.ShouldBindJSON(&body); err != nil && !errors.Is(err, io.EOF) {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Body permintaan tidak valid.")
		return
	}
	if body.IsRead != nil && !*body.IsRead {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "is_read hanya boleh bernilai true.")
		return
	}
	actor := notification.Actor{ID: id.UserID, Role: id.Role, LocationID: id.LocationID}
	if err := h.notifications.MarkRead(c.Request.Context(), actor, parsed); err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, notificationMarkReadDTO{ID: string(parsed), IsRead: true})
}

// MarkAllRead serves POST /notifications/read-all.
func (h *NotificationHandler) MarkAllRead(c *gin.Context) {
	id, ok := requireNotificationRole(c)
	if !ok {
		return
	}
	if h.notifications == nil {
		response.Fail(c, domain.ErrDatabase)
		return
	}
	actor := notification.Actor{ID: id.UserID, Role: id.Role, LocationID: id.LocationID}
	updated, err := h.notifications.MarkAllRead(c.Request.Context(), actor)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, notificationReadAllDTO{Updated: updated})
}

// requireNotificationRole admits every authenticated role (super_admin, admin,
// security and vendor - each only ever sees its own notifications); it refuses
// anything else with the 403 sentinel.
func requireNotificationRole(c *gin.Context) (deliveryhttp.Identity, bool) {
	id, ok := deliveryhttp.IdentityFrom(c)
	if !ok {
		response.Fail(c, domain.ErrUnauthorized)
		return deliveryhttp.Identity{}, false
	}
	switch id.Role {
	case domain.RoleSuperAdmin, domain.RoleAdmin, domain.RoleSecurity, domain.RoleVendor:
		return id, true
	default:
		response.Fail(c, domain.ErrForbiddenBranch)
		return deliveryhttp.Identity{}, false
	}
}
