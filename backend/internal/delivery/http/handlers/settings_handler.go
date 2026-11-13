package handlers

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	deliveryhttp "thc-vms/backend/internal/delivery/http"
	"thc-vms/backend/internal/delivery/http/middleware"
	"thc-vms/backend/internal/delivery/http/response"
	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/settings"
	"thc-vms/backend/internal/usecase/visit"
)

// SettingsHandler serves the app settings matrix (super_admin only) plus the
// dev-superadmin-only observability probes (system status, test mail).
type SettingsHandler struct {
	settings *settings.Service
	users    SettingsUserLookup
	mailer   domain.Mailer
	audit    domain.AuditRepository
	testMail *testMailLimiter
}

// SettingsUserLookup resolves the caller's own account for the test-mail
// probe. The PostgreSQL user adapter satisfies it through FindByID.
type SettingsUserLookup interface {
	FindByID(ctx context.Context, id domain.UUID) (domain.User, error)
}

// NewSettingsHandler wires the handler to the settings usecase.
func NewSettingsHandler(svc *settings.Service) *SettingsHandler {
	return &SettingsHandler{settings: svc, testMail: newTestMailLimiter()}
}

// WithUsers wires the account lookup behind POST /settings/test-mail.
// It returns the handler for chained wiring at the composition root.
func (h *SettingsHandler) WithUsers(users SettingsUserLookup) *SettingsHandler {
	h.users = users
	return h
}

// WithMailer wires the sending port behind POST /settings/test-mail (nil
// when SMTP is disabled: the probe then answers 503 instead of sending).
// It returns the handler for chained wiring at the composition root.
func (h *SettingsHandler) WithMailer(mailer domain.Mailer) *SettingsHandler {
	h.mailer = mailer
	return h
}

// WithAudit wires the trail behind POST /settings/test-mail. The row is
// best-effort (a failed append is logged, never fails the send). It returns
// the handler for chained wiring at the composition root.
func (h *SettingsHandler) WithAudit(audit domain.AuditRepository) *SettingsHandler {
	h.audit = audit
	return h
}

// requireDevSuperAdmin admits ONLY the hidden dev-superadmin: unlike
// requireSuperAdmin it does NOT admit super_admin. Anonymous callers get
// the 401 envelope, every other role (super_admin included) gets the 403
// sentinel, mirroring the router's SuperAdminOnly chain which both roles
// pass before this narrower handler gate.
func requireDevSuperAdmin(c *gin.Context) (deliveryhttp.Identity, bool) {
	id, ok := deliveryhttp.IdentityFrom(c)
	if !ok {
		response.Fail(c, domain.ErrUnauthorized)
		return deliveryhttp.Identity{}, false
	}
	if id.Role != domain.RoleDevSuperAdmin {
		response.Fail(c, domain.ErrForbiddenBranch)
		return deliveryhttp.Identity{}, false
	}
	return id, true
}

// testMailLimiter is the in-memory fixed-window gate for POST
// /settings/test-mail: at most 3 sends per user per hour. State lives in a
// mutex-guarded map (no Redis for one back-office probe); hits older than
// the window are pruned on every check so the map cannot grow unboundedly.
type testMailLimiter struct {
	mu   sync.Mutex
	hits map[string][]time.Time
}

const (
	testMailMaxPerHour = 3
	testMailWindow     = time.Hour
)

func newTestMailLimiter() *testMailLimiter {
	return &testMailLimiter{hits: make(map[string][]time.Time)}
}

// allow records one attempt and reports whether it stays within the window.
// Every call counts, even a denied one, so a burst cannot slip through by
// retrying against a stale count.
func (l *testMailLimiter) allow(userID string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	cutoff := now.Add(-testMailWindow)
	kept := make([]time.Time, 0, len(l.hits[userID])+1)
	for _, t := range l.hits[userID] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	kept = append(kept, now)
	l.hits[userID] = kept
	return len(kept) <= testMailMaxPerHour
}

// testMailSubject carries the explicit [EMAIL TES] marker in the subject so
// the probe can never be mistaken for a lifecycle notice.
const testMailSubject = "[EMAIL TES] Uji kirim email THC-VMS"

// testMailContent renders the probe body from the shared branded template
// (the same wrapper as the lifecycle mails): a greeting plus the explicit
// [EMAIL TES] marker, with no call-to-action button.
func testMailContent() (subject, textBody, htmlBody string) {
	title := testMailSubject
	message := "Halo, ini adalah email tes dari THC Visitor Management System. " +
		"Jika Anda menerima email ini, berarti konfigurasi pengiriman email berfungsi dengan baik. " +
		"Mohon abaikan email ini; tidak ada tindakan yang diperlukan."
	textBody = title + "\n\n" + message
	htmlBody = domain.RenderBrandedActionEmail(title, message, "", "")
	return title, textBody, htmlBody
}

// settingsToggleWire is the wire shape for one matrix row.
type settingsToggleWire struct {
	Event     string                           `json:"event"`
	InApp     domain.NotificationChannelToggle `json:"in_app"`
	Email     domain.NotificationChannelToggle `json:"email"`
	Mandatory bool                             `json:"mandatory"`
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

// systemMailerWire is the mailer half of GET /settings/system.
type systemMailerWire struct {
	QueueDepth int   `json:"queueDepth"`
	Dropped    int64 `json:"dropped"`
}

// systemStatusWire is the GET /settings/system payload: dbVersion is null
// while no migration is applied yet.
type systemStatusWire struct {
	DBVersion   *int             `json:"dbVersion"`
	RepoVersion int              `json:"repoVersion"`
	InSync      bool             `json:"inSync"`
	Mailer      systemMailerWire `json:"mailer"`
}

func toSystemStatus(st settings.SystemStatus) systemStatusWire {
	return systemStatusWire{
		DBVersion:   st.DBVersion,
		RepoVersion: st.RepoVersion,
		InSync:      st.InSync,
		Mailer:      systemMailerWire{QueueDepth: st.Mailer.QueueDepth, Dropped: st.Mailer.Dropped},
	}
}

// testMailResultWire is the POST /settings/test-mail payload: the inbox the
// single probe mail was queued for (always the caller's own address).
type testMailResultWire struct {
	Sent bool   `json:"sent"`
	To   string `json:"to"`
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

// System serves GET /settings/system: the read-only migration/mailer probe
// for the hidden dev-superadmin only.
func (h *SettingsHandler) System(c *gin.Context) {
	if _, ok := requireDevSuperAdmin(c); !ok {
		return
	}
	st, err := h.settings.SystemStatus(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, toSystemStatus(st))
}

// TestMail serves POST /settings/test-mail: it queues exactly one sample
// mail to the caller's own inbox and nothing else. The recipient is resolved
// server-side from the caller identity; any request body is ignored, so a
// crafted payload can never redirect the probe to a third party.
func (h *SettingsHandler) TestMail(c *gin.Context) {
	id, ok := requireDevSuperAdmin(c)
	if !ok {
		return
	}
	if !h.testMail.allow(string(id.UserID)) {
		middleware.EmailChangeRateLimited(c)
		return
	}
	to := ""
	if h.users != nil {
		user, err := h.users.FindByID(c.Request.Context(), id.UserID)
		if err != nil {
			response.Fail(c, err)
			return
		}
		to = strings.TrimSpace(user.Email)
	}
	if to == "" {
		response.FailWith(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Terjadi kesalahan pada server.")
		return
	}
	if h.mailer == nil {
		response.FailWith(c, http.StatusServiceUnavailable, "MAILER_DISABLED", "Layanan email tidak aktif.")
		return
	}
	subject, textBody, htmlBody := testMailContent()
	if err := h.mailer.Send(c.Request.Context(), []string{to}, subject, textBody, htmlBody); err != nil {
		response.Fail(c, err)
		return
	}
	// Jejak audit best-effort seperti PUT: gagal tulis tidak menggagalkan
	// kirim yang sudah antre.
	if h.audit != nil {
		entry := auditEntry(c, id.UserID,
			domain.AuditActionSettingsUpdate, domain.AuditEntitySettings, nil,
			map[string]string{"key": "settings.test-mail"})
		if _, err := h.audit.Append(c.Request.Context(), entry); err != nil {
			slog.Warn("settings: test-mail audit append failed", "err", err)
		}
	}
	response.OK(c, testMailResultWire{Sent: true, To: to})
}
