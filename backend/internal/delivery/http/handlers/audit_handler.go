package handlers

import (
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/response"
	"thc-vms/backend/internal/domain"
)

// AuditHandler serves the super_admin trail read (GET /audit-logs). It only
// maps HTTP onto domain.AuditRepository.List: the row set is global by design
// (no location_id narrowing — the trail is the super_admin console's own
// history, and RequireRoles(super_admin) on the route is the only gate).
// Role gating is defence in depth: the router mounts this behind
// SuperAdminOnly, and List re-asserts the role so direct handler tests prove
// the 403 without the middleware.
type AuditHandler struct {
	audit domain.AuditRepository
}

// NewAuditHandler wires the handler to the audit-trail read port.
func NewAuditHandler(audit domain.AuditRepository) *AuditHandler {
	return &AuditHandler{audit: audit}
}

// auditLogDTO mirrors the openapi AuditLog shape: identifiers render null
// when the row carries none (system/failed-login rows), timestamps are
// RFC3339, and metadata stays the secret-free fact bag the writers stored.
type auditLogDTO struct {
	ID        string            `json:"id"`
	UserID    *string           `json:"user_id"`
	Action    string            `json:"action"`
	Entity    string            `json:"entity"`
	EntityID  *string           `json:"entity_id"`
	Timestamp string            `json:"timestamp"`
	IP        string            `json:"ip"`
	UserAgent string            `json:"user_agent"`
	Metadata  map[string]string `json:"metadata"`
}

// auditListDTO mirrors the AuditLogListResponse data object: {items, total,
// page, limit}. It is never a bare array.
type auditListDTO struct {
	Items []auditLogDTO `json:"items"`
	Total int64         `json:"total"`
	Page  int           `json:"page"`
	Limit int           `json:"limit"`
}

// toAuditLog projects one stored trail row onto the wire shape.
func toAuditLog(row domain.AuditLog) auditLogDTO {
	out := auditLogDTO{
		ID:        string(row.ID),
		Action:    row.Action,
		Entity:    row.Entity,
		Timestamp: row.Timestamp.Format(time.RFC3339),
		IP:        row.IP,
		UserAgent: row.UserAgent,
		Metadata:  row.Metadata,
	}
	if row.UserID != nil {
		id := string(*row.UserID)
		out.UserID = &id
	}
	if row.EntityID != nil {
		id := string(*row.EntityID)
		out.EntityID = &id
	}
	return out
}

// List serves GET /audit-logs with 200: the filtered trail page with its
// companion total. Every filter member is optional (absent means unfiltered);
// an unparsable user_id or date bound is a 400, never a silent listing.
func (h *AuditHandler) List(c *gin.Context) {
	if _, ok := requireSuperAdmin(c); !ok {
		return
	}
	if h.audit == nil {
		response.Fail(c, domain.ErrDatabase)
		return
	}
	page := queryInt(c.Query("page"), 1)
	limit := queryInt(c.Query("limit"), 20)
	filter := domain.AuditFilter{
		Entity: strings.TrimSpace(c.Query("entity")),
		Action: strings.TrimSpace(c.Query("action")),
		Limit:  limit,
		Offset: (page - 1) * limit,
	}
	if raw := strings.TrimSpace(c.Query("user_id")); raw != "" {
		parsed, err := domain.ParseUUID(raw)
		if err != nil {
			response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "user_id tidak valid.")
			return
		}
		filter.UserID = &parsed
	}
	from, err := parseVisitDateBound(strings.TrimSpace(c.Query("date_from")), false)
	if err != nil {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Format date_from tidak valid.")
		return
	}
	to, err := parseVisitDateBound(strings.TrimSpace(c.Query("date_to")), true)
	if err != nil {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Format date_to tidak valid.")
		return
	}
	if from != nil && to != nil && from.After(*to) {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Rentang tanggal tidak valid: date_from harus sebelum date_to.")
		return
	}
	filter.From, filter.To = from, to
	items, total, err := h.audit.List(c.Request.Context(), filter)
	if err != nil {
		response.Fail(c, err)
		return
	}
	rows := make([]auditLogDTO, 0, len(items))
	for _, item := range items {
		rows = append(rows, toAuditLog(item))
	}
	response.OK(c, auditListDTO{Items: rows, Total: total, Page: page, Limit: limit})
}
