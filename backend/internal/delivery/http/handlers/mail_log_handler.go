package handlers

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/response"
	"thc-vms/backend/internal/domain"
)

// MailLogHandler serves the mail delivery trail reads (super_admin only: the
// trail is the back-office's own observability, never branch-scoped, and the
// hidden dev-superadmin passes the gate like super_admin). It only maps HTTP
// onto domain.MailLogRepository: no audit row is written for these reads (a
// read-only probe, same as GET /settings/system).
type MailLogHandler struct {
	logs domain.MailLogRepository
}

// NewMailLogHandler wires the handler to the mail-log read port.
func NewMailLogHandler(logs domain.MailLogRepository) *MailLogHandler {
	return &MailLogHandler{logs: logs}
}

// mailLogItemDTO is one trail row on the wire: the flush recipients, the
// hidden Bcc overseers, the lifecycle template label ("" for direct sends),
// the queued/sent/failed verdict, the attempts performed, the final error
// text (null unless failed) and the RFC3339 instants (sentAt null until the
// verdict lands).
type mailLogItemDTO struct {
	ID        string   `json:"id"`
	To        []string `json:"to"`
	Bcc       []string `json:"bcc"`
	Subject   string   `json:"subject"`
	Template  string   `json:"template"`
	Status    string   `json:"status"`
	Attempts  int      `json:"attempts"`
	Error     *string  `json:"error"`
	CreatedAt string   `json:"createdAt"`
	SentAt    *string  `json:"sentAt"`
}

// mailLogListDTO is the list response data object: {items, total, page,
// limit}. It is never a bare array.
type mailLogListDTO struct {
	Items []mailLogItemDTO `json:"items"`
	Total int64            `json:"total"`
	Page  int              `json:"page"`
	Limit int              `json:"limit"`
}

// mailLogDetailDTO is the single-row response data object: the list members
// plus the plain-text diagnosis copy. The HTML copy is deliberately absent
// (see the migration header).
type mailLogDetailDTO struct {
	mailLogItemDTO
	TextBody *string `json:"textBody"`
}

// toMailLogItem projects one stored verdict onto the wire shape.
func toMailLogItem(row domain.MailLog) mailLogItemDTO {
	out := mailLogItemDTO{
		ID:        string(row.ID),
		To:        row.Recipients,
		Bcc:       row.Bcc,
		Subject:   row.Subject,
		Template:  row.Template,
		Status:    string(row.Status),
		Attempts:  row.Attempts,
		Error:     row.Error,
		CreatedAt: row.CreatedAt.Format(time.RFC3339),
	}
	if out.To == nil {
		out.To = []string{}
	}
	if out.Bcc == nil {
		out.Bcc = []string{}
	}
	if row.SentAt != nil {
		at := row.SentAt.Format(time.RFC3339)
		out.SentAt = &at
	}
	return out
}

// List serves GET /settings/mail-logs with 200: the filtered verdict page
// with its companion total. Status is the only filter (absent means
// unfiltered); an unknown value is a 400, never a silent listing.
func (h *MailLogHandler) List(c *gin.Context) {
	if _, ok := requireSuperAdmin(c); !ok {
		return
	}
	if h.logs == nil {
		response.Fail(c, domain.ErrDatabase)
		return
	}
	status, ok := domain.ParseMailLogStatus(c.Query("status"))
	if !ok {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Status log email tidak valid.")
		return
	}
	page := queryInt(c.Query("page"), 1)
	filter := domain.NormaliseMailLogFilter(domain.MailLogFilter{Page: page, Limit: queryInt(c.Query("limit"), 0)})
	if c.Query("status") != "" {
		s := status
		filter.Status = &s
	}
	items, total, err := h.logs.List(c.Request.Context(), filter)
	if err != nil {
		response.Fail(c, err)
		return
	}
	rows := make([]mailLogItemDTO, 0, len(items))
	for _, item := range items {
		rows = append(rows, toMailLogItem(item))
	}
	response.OK(c, mailLogListDTO{
		Items: rows,
		Total: total,
		Page:  filter.Page,
		Limit: filter.Limit,
	})
}

// Get serves GET /settings/mail-logs/:id with 200: one verdict with its
// plain-text body. An unparsable id is a 400, a missing id a 404.
func (h *MailLogHandler) Get(c *gin.Context) {
	if _, ok := requireSuperAdmin(c); !ok {
		return
	}
	if h.logs == nil {
		response.Fail(c, domain.ErrDatabase)
		return
	}
	id, err := domain.ParseUUID(c.Param("id"))
	if err != nil {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "ID log email tidak valid.")
		return
	}
	row, err := h.logs.FindByID(c.Request.Context(), id)
	if err != nil {
		response.Fail(c, err)
		return
	}
	detail := mailLogDetailDTO{mailLogItemDTO: toMailLogItem(row), TextBody: row.TextBody}
	response.OK(c, detail)
}
