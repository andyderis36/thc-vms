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
)

// Frozen password-reset wire constants. The request answer stays generic so
// the endpoint never reveals whether an address is registered (unknown emails
// succeed with the same 202); the confirm failure stays byte-identical
// across expired, consumed, tampered and unknown tokens so the endpoint never
// becomes an account oracle. The handler logs nothing: tokens, emails and
// passwords never reach a log beyond the user_id the audit trail owns.
const (
	passwordResetRequestMessage = "Jika email terdaftar, tautan reset kata sandi telah dikirim."
	passwordResetConfirmMessage = "Kata sandi berhasil diubah. Silakan masuk dengan kata sandi baru."
)

// PasswordResetService is the narrow seam this handler needs: it is
// satisfied by *auth.Service in production and by hand-written fakes in
// tests. RequestPasswordReset/ConfirmPasswordReset are the T6 usecase pair:
// the request leg takes the raw email plus the client IP (the usecase
// normalises and validates the shape), the confirm leg takes the opaque raw
// token plus the new password.
type PasswordResetService interface {
	RequestPasswordReset(ctx context.Context, email, ip string) error
	ConfirmPasswordReset(ctx context.Context, rawToken, newPassword string) error
}

// PasswordResetLimiter is the narrow anti-abuse seam: it is satisfied by
// *middleware.PasswordResetRateLimiter in production and by hand-written
// fakes in tests. The endpoints are PUBLIC (no identity exists yet), so both
// directions key on the client IP plus the target email, never a user id.
type PasswordResetLimiter interface {
	AllowRequest(ip, targetEmail string) bool
	AllowConfirm(ip string) bool
}

// PasswordResetHandler serves POST /auth/password-reset/request (202 generic)
// and POST /auth/password-reset/confirm (200 generic message, byte-identical
// 401 otherwise). Every answer goes through the response envelope; no handler
// invents a key.
type PasswordResetHandler struct {
	passwordReset PasswordResetService
	limiter       PasswordResetLimiter
}

// NewPasswordResetHandler wires the handler to its usecase and limiter
// seams. A nil limiter disables throttling (hermetic tests); production
// always passes the rate limiter.
func NewPasswordResetHandler(svc PasswordResetService, limiter PasswordResetLimiter) *PasswordResetHandler {
	return &PasswordResetHandler{passwordReset: svc, limiter: limiter}
}

// passwordResetRequestBody mirrors the request schema: exactly email.
type passwordResetRequestBody struct {
	Email string `json:"email"`
}

// passwordResetRequestData mirrors the generic request data object: exactly
// message.
type passwordResetRequestData struct {
	Message string `json:"message"`
}

// passwordResetConfirmBody mirrors the confirm schema: exactly token and
// new_password.
type passwordResetConfirmBody struct {
	Token       string `json:"token"`
	NewPassword string `json:"new_password"`
}

// passwordResetConfirmData mirrors the generic confirm data object: exactly
// message.
type passwordResetConfirmData struct {
	Message string `json:"message"`
}

// RequestPasswordReset serves POST /auth/password-reset/request: strict body,
// limiter-second (a rejected body never burns rate-limit budget), then the
// usecase validates the shape (422 on a bad shape via FromError), looks the
// account up and mints/mails the reset link. Success is ALWAYS 202 with the
// generic message - even when the email is unknown (the usecase succeeds
// silently with NO row and NO mail) - while a pending account passes through
// as 403 ACCOUNT_PENDING and an inactive one as 403 ACCOUNT_INACTIVE.
func (h *PasswordResetHandler) RequestPasswordReset(c *gin.Context) {
	var body passwordResetRequestBody
	if err := decodeStrictBody(c, &body); err != nil {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Format isi permintaan tidak valid.")
		return
	}
	if h.limiter != nil && !h.limiter.AllowRequest(c.ClientIP(), body.Email) {
		middleware.PasswordResetRateLimited(c)
		return
	}
	if _, err := domain.ValidatePasswordResetRequest(body.Email); err != nil {
		response.Fail(c, err)
		return
	}
	ctx := deliveryhttp.ContextWithRequestMeta(c.Request.Context(), c)
	if err := h.passwordReset.RequestPasswordReset(ctx, body.Email, c.ClientIP()); err != nil {
		response.Fail(c, err)
		return
	}
	raw, err := json.Marshal(passwordResetRequestData{Message: passwordResetRequestMessage})
	if err != nil {
		response.FailWith(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Terjadi kesalahan pada server.")
		return
	}
	c.JSON(http.StatusAccepted, response.Envelope{Success: true, Data: raw})
}

// ConfirmPasswordReset serves POST /auth/password-reset/confirm: strict
// body, limiter-second (a rejected body never burns rate-limit budget), then
// the usecase rotates the password through the single atomic token-consume
// port. Success is 200 with the generic message (no session token: the caller
// signs in separately through POST /auth/login). EVERY token failure (stale,
// consumed, expired, tampered, unknown, malformed body, even wiring bugs)
// renders the same byte-identical 401 from domain.PasswordResetLinkInvalid so
// the responses stay indistinguishable; only the weak-password 400 and the
// 429 throttle pass through untouched.
func (h *PasswordResetHandler) ConfirmPasswordReset(c *gin.Context) {
	var body passwordResetConfirmBody
	if err := decodeStrictBody(c, &body); err != nil ||
		strings.TrimSpace(body.Token) == "" || strings.TrimSpace(body.NewPassword) == "" {
		response.Fail(c, domain.PasswordResetLinkInvalid())
		return
	}
	if h.limiter != nil && !h.limiter.AllowConfirm(c.ClientIP()) {
		middleware.PasswordResetRateLimited(c)
		return
	}
	ctx := deliveryhttp.ContextWithRequestMeta(c.Request.Context(), c)
	if err := h.passwordReset.ConfirmPasswordReset(ctx, body.Token, body.NewPassword); err != nil {
		if appErr := domain.FromError(err); appErr.Status == http.StatusBadRequest {
			response.Fail(c, err)
			return
		}
		response.Fail(c, domain.PasswordResetLinkInvalid())
		return
	}
	raw, err := json.Marshal(passwordResetConfirmData{Message: passwordResetConfirmMessage})
	if err != nil {
		response.FailWith(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Terjadi kesalahan pada server.")
		return
	}
	c.JSON(http.StatusOK, response.Envelope{Success: true, Data: raw})
}
