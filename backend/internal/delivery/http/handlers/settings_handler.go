package handlers

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/response"
	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/settings"
	"thc-vms/backend/internal/usecase/visit"
)

// SettingsHandler serves the app settings matrix (super_admin only).
type SettingsHandler struct {
	settings *settings.Service
}

// NewSettingsHandler wires the handler to the settings usecase.
func NewSettingsHandler(svc *settings.Service) *SettingsHandler {
	return &SettingsHandler{settings: svc}
}

// settingsToggleWire is the wire shape for one matrix row.
type settingsToggleWire struct {
	Event     string                          `json:"event"`
	InApp     domain.NotificationChannelToggle `json:"in_app"`
	Email     domain.NotificationChannelToggle `json:"email"`
	Mandatory bool                            `json:"mandatory"`
}

// settingsMatrixWire is the GET/PUT response payload.
type settingsMatrixWire struct {
	Toggles []settingsToggleWire `json:"toggles"`
	Version int                  `json:"version"`
}

func toSettingsMatrix(st domain.NotificationSettings) settingsMatrixWire {
	out := settingsMatrixWire{Version: st.Version}
	for _, t := range []domain.NotificationType{
		domain.NotificationVisitRequested, domain.NotificationVisitRescheduled, domain.NotificationVisitCheckIn,
		domain.NotificationVisitCheckOut, domain.NotificationVisitCancelled, domain.NotificationVisitApproved,
		domain.NotificationVisitRejected, domain.NotificationVisitReminder, domain.NotificationVisitAutoCancelled,
	} {
		tg := st.Toggles[t]
		tg.Mandatory = domain.IsMandatoryNotification(t)
		out.Toggles = append(out.Toggles, settingsToggleWire{
			Event:     string(t),
			InApp:     tg.InApp,
			Email:     tg.Email,
			Mandatory: tg.Mandatory,
		})
	}
	return out
}

// Get serves GET /settings/notifications.
func (h *SettingsHandler) Get(c *gin.Context) {
	_, ok := requireSuperAdmin(c)
	if !ok {
		return
	}
	st, err := h.settings.Get(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, toSettingsMatrix(st))
}

// Update serves PUT /settings/notifications.
func (h *SettingsHandler) Update(c *gin.Context) {
	id, ok := requireSuperAdmin(c)
	if !ok {
		return
	}
	var body settings.UpdateInput
	if err := c.ShouldBindJSON(&body); err != nil {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Format isi permintaan tidak valid.")
		return
	}
	actor := visit.Actor{ID: id.UserID, Role: id.Role, LocationID: id.LocationID}
	// Baca nilai lama SEBELUM tulis agar jejak audit membawa old/new
	// aktual, bukan string kosong. Get yang gagal tidak menggagalkan
	// tulis: old dibiarkan kosong dan Update tetap berjalan.
	oldRaw := ""
	if old, err := h.settings.Get(c.Request.Context()); err != nil {
		slog.Warn("settings: read old value for audit failed", "err", err)
	} else if raw, err := json.Marshal(old); err != nil {
		slog.Warn("settings: encode old value for audit failed", "err", err)
	} else {
		oldRaw = string(raw)
	}
	auditEntry := domain.AuditEntry{
		ActorID:  &id.UserID,
		Action:   domain.AuditActionSettingsUpdate,
		Entity:   domain.AuditEntitySettings,
		Metadata: map[string]string{"key": domain.SettingsKeyNotifications, "old": oldRaw, "new": ""},
	}
	st, err := h.settings.Update(c.Request.Context(), actor, body, auditEntry)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, toSettingsMatrix(st))
}
