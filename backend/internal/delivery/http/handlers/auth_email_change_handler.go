package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	deliveryhttp "thc-vms/backend/internal/delivery/http"
	"thc-vms/backend/internal/delivery/http/middleware"
	"thc-vms/backend/internal/delivery/http/response"
	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/auth"
)

// Frozen email-change wire constants (docs/4. openapi.yaml §/auth/email-change,
// frontend EmailChangeRequestResult/EmailChangeConfirmRequest). The request
// answer stays generic so the endpoint never reveals whether an address is
// taken; the confirm failure stays byte-identical across stale, cross-user,
// expired, taken and wiring failures so the endpoint never becomes an account
// oracle. The handler logs nothing: tokens and passwords never reach a log.
const (
	emailChangeRequestMessage = "Tautan verifikasi telah dikirim ke email baru Anda."
	emailChangeInvalidCode    = "INVALID_TOKEN"
	emailChangeInvalidMessage = "Tautan tidak valid atau kedaluwarsa."
)

// EmailChangeService is the narrow seam this handler needs: it is satisfied by
// *auth.Service in production and by hand-written fakes in tests. Me resolves
// the caller's stored address (the frozen request body carries no old
// address); RequestEmailChange/ConfirmEmailChange are the T4 usecase pair.
type EmailChangeService interface {
	Me(ctx context.Context, userID domain.UUID) (auth.Profile, error)
	RequestEmailChange(ctx context.Context, userID domain.UUID, oldEmail, newEmail, currentPassword string) (string, error)
	ConfirmEmailChange(ctx context.Context, userID domain.UUID, token string) (auth.Profile, error)
}

// EmailChangeLimiter is the narrow anti-abuse seam: it is satisfied by
// *middleware.EmailChangeRateLimiter in production and by hand-written fakes
// in tests.
type EmailChangeLimiter interface {
	AllowRequest(userID, ip, targetEmail string) bool
	AllowConfirm(userID, ip string) bool
}

// EmailChangeHandler serves POST /auth/email-change/request (202 generic) and
// POST /auth/email-change/confirm (200 User, generic 400 otherwise). Every
// answer goes through the response envelope; no handler invents a key.
type EmailChangeHandler struct {
	emailChange EmailChangeService
	limiter     EmailChangeLimiter
}

// NewEmailChangeHandler wires the handler to its usecase and limiter seams.
// A nil limiter disables throttling (hermetic tests); production always
// passes the T3 rate limiter.
func NewEmailChangeHandler(svc EmailChangeService, limiter EmailChangeLimiter) *EmailChangeHandler {
	return &EmailChangeHandler{emailChange: svc, limiter: limiter}
}

// emailChangeRequestBody mirrors the openapi EmailChangeRequest schema:
// exactly new_email and current_password. The stored address is resolved
// server-side through Me, never trusted from the client.
type emailChangeRequestBody struct {
	NewEmail        string `json:"new_email"`
	CurrentPassword string `json:"current_password"`
}

// emailChangeRequestData mirrors the openapi EmailChangeRequestResponse data
// object: exactly message.
type emailChangeRequestData struct {
	Message string `json:"message"`
}

// emailChangeConfirmBody mirrors the openapi EmailChangeConfirmRequest
// schema: exactly token.
type emailChangeConfirmBody struct {
	Token string `json:"token"`
}

// RequestEmailChange serves POST /auth/email-change/request: strict body,
// limiter-first, then the usecase mints and mails the verification link to
// the NEW inbox. Success is always 202 with the generic message (even when
// the new address is taken — the usecase deliberately reports nothing); a
// wrong current password passes through as 401.
func (h *EmailChangeHandler) RequestEmailChange(c *gin.Context) {
	id, ok := deliveryhttp.IdentityFrom(c)
	if !ok {
		response.Fail(c, domain.ErrUnauthorized)
		return
	}
	var body emailChangeRequestBody
	if err := decodeStrictBody(c, &body); err != nil {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Format isi permintaan tidak valid.")
		return
	}
	if h.limiter != nil && !h.limiter.AllowRequest(string(id.UserID), c.ClientIP(), body.NewEmail) {
		middleware.EmailChangeRateLimited(c)
		return
	}
	ctx := deliveryhttp.ContextWithRequestMeta(c.Request.Context(), c)
	me, err := h.emailChange.Me(ctx, id.UserID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	if _, err := h.emailChange.RequestEmailChange(ctx, id.UserID, me.Email, body.NewEmail, body.CurrentPassword); err != nil {
		response.Fail(c, err)
		return
	}
	raw, err := json.Marshal(emailChangeRequestData{Message: emailChangeRequestMessage})
	if err != nil {
		response.FailWith(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Terjadi kesalahan pada server.")
		return
	}
	c.JSON(http.StatusAccepted, response.Envelope{Success: true, Data: raw})
}

// ConfirmEmailChange serves POST /auth/email-change/confirm: strict body,
// limiter-first, then the usecase flips the stored email. Success is 200
// with the openapi User projection; EVERY failure (stale row, cross-user
// token, expired/tampered token, taken address, malformed body, wiring bug)
// renders the same 400 INVALID_TOKEN so the responses stay indistinguishable.
// Only the 429 throttle passes through untouched.
func (h *EmailChangeHandler) ConfirmEmailChange(c *gin.Context) {
	id, ok := deliveryhttp.IdentityFrom(c)
	if !ok {
		response.Fail(c, domain.ErrUnauthorized)
		return
	}
	var body emailChangeConfirmBody
	if err := decodeStrictBody(c, &body); err != nil || strings.TrimSpace(body.Token) == "" {
		response.FailWith(c, http.StatusBadRequest, emailChangeInvalidCode, emailChangeInvalidMessage)
		return
	}
	if h.limiter != nil && !h.limiter.AllowConfirm(string(id.UserID), c.ClientIP()) {
		middleware.EmailChangeRateLimited(c)
		return
	}
	ctx := deliveryhttp.ContextWithRequestMeta(c.Request.Context(), c)
	profile, err := h.emailChange.ConfirmEmailChange(ctx, id.UserID, body.Token)
	if err != nil {
		response.FailWith(c, http.StatusBadRequest, emailChangeInvalidCode, emailChangeInvalidMessage)
		return
	}
	response.OK(c, profileToAccount(profile))
}
