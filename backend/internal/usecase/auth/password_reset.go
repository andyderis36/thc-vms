package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"golang.org/x/crypto/bcrypt"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/validation"
)

// hashPasswordResetToken renders the SHA-256 hex digest stored for one raw
// bearer: the database never sees the raw token, so a leaked dump cannot
// reset passwords.
func hashPasswordResetToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// mintPasswordResetToken draws 32 crypto/rand bytes and base64url-encodes
// them for the reset link: 256 bits of entropy, URL-safe without escaping.
func mintPasswordResetToken() (string, error) {
	var buf [32]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf[:]), nil
}

// passwordResetServerError is the fixed 500 the mint/store path renders when
// randomness or the token row fails, mirroring the email-change mint failure
// shape and tone.
func passwordResetServerError() *domain.AppError {
	return &domain.AppError{Status: http.StatusInternalServerError, Code: "INTERNAL_ERROR", Message: "Terjadi kesalahan pada server."}
}

// RequestPasswordReset starts a self-service password reset for one email
// address: normalise and validate the shape (422 on a bad shape via the
// domain helper), look the account up, and mint an opaque single-use token
// mailed as a reset link. An unknown email succeeds silently with NO row and
// NO mail so the endpoint never becomes an account oracle; pending accounts
// fail closed with 403 naming the wait and inactive ones with 403 naming the
// deactivation, exactly like the login status gates. A nil token store is a
// wiring bug (500), never a user error. The mail and the audit trail are
// both best-effort: their failure is logged and the request still succeeds,
// and a nil mailer or audit writer disables only its own leg. The raw token
// travels in the mail body only; it is never logged and never stored.
func (s *Service) RequestPasswordReset(ctx context.Context, email, ip string) error {
	req, err := domain.ValidatePasswordResetRequest(email)
	if err != nil {
		return err
	}
	if s.users == nil || s.resets == nil {
		return domain.FromError(errUnwired)
	}
	user, err := s.users.FindByEmail(ctx, req.Email)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			return nil
		}
		return domain.FromError(err)
	}
	if user.Status == domain.UserStatusPending {
		return domain.AccountPending()
	}
	if user.Status == domain.UserStatusInactive {
		return domain.AccountInactive()
	}
	if user.Status != domain.UserStatusActive {
		return domain.InvalidCredentials()
	}
	raw, err := mintPasswordResetToken()
	if err != nil {
		slog.Warn("auth: password-reset mint failed", "error", err)
		return passwordResetServerError()
	}
	var requestedIP *string
	if trimmed := strings.TrimSpace(ip); trimmed != "" {
		requestedIP = &trimmed
	}
	if err := s.resets.InsertToken(ctx, user.ID, hashPasswordResetToken(raw),
		domain.PasswordResetExpiresAt(s.clock.Now()), requestedIP); err != nil {
		slog.Warn("auth: password-reset store failed", "user_id", string(user.ID), "error", err)
		return passwordResetServerError()
	}
	s.sendPasswordResetMail(ctx, req.Email, raw)
	s.recordPasswordReset(ctx, user.ID)
	return nil
}

// ConfirmPasswordReset completes a self-service password reset: it validates
// the new password against the shared policy (the same validation.ValidPassword
// the managed-user create and the self-service rotation enforce — a weak
// value is 400 and consumes nothing), bcrypt-hashes it, then redeems the
// token through the single atomic port call that consumes the row AND rotates
// the stored hash in one transaction. Any lookup miss — expired, consumed,
// tampered, or unknown — renders the byte-identical 401 link message, and a
// concurrent second confirm loses the row-lock race to the same 401. The
// audit trail is best-effort. Success returns nothing: the caller signs in
// separately through POST /auth/login.
func (s *Service) ConfirmPasswordReset(ctx context.Context, rawToken, newPassword string) error {
	if s.resets == nil {
		return domain.FromError(errUnwired)
	}
	if err := validation.ValidPassword(newPassword); err != nil {
		return &domain.AppError{Status: http.StatusBadRequest, Code: "VALIDATION_ERROR", Message: err.Error()}
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
	if err != nil {
		return domain.FromError(err)
	}
	userID, err := s.resets.ConsumeToken(ctx, hashPasswordResetToken(rawToken), string(hash), s.clock.Now())
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			slog.Warn("auth: password-reset confirm rejected", "reason", "lookup")
			return domain.PasswordResetLinkInvalid()
		}
		return domain.FromError(err)
	}
	s.recordPasswordReset(ctx, userID)
	return nil
}

// sendPasswordResetMail mails the reset link to the account inbox only. It is
// strictly best-effort: a send failure is logged and the request still
// succeeds, and a nil mailer only skips the notice. The raw token travels in
// the body (the holder proves control of the inbox); it is never logged.
func (s *Service) sendPasswordResetMail(ctx context.Context, email, rawToken string) {
	if s.mailer == nil {
		slog.Warn("auth: password-reset mail skipped", "reason", "mailer_unwired")
		return
	}
	link := "/reset-password?token=" + rawToken
	if s.frontendBaseURL != "" {
		link = s.frontendBaseURL + link
	}
	text := fmt.Sprintf("Klik tautan berikut untuk mengatur ulang kata sandi akun THC-VMS Anda:\n%s\nTautan ini kedaluwarsa dalam 30 menit. Abaikan email ini jika Anda tidak memintanya.", link)
	htmlBody := domain.RenderBrandedActionEmail(
		"Atur Ulang Kata Sandi",
		"Klik tombol berikut untuk mengatur ulang kata sandi akun THC-VMS Anda. Tautan ini kedaluwarsa dalam 30 menit. Abaikan email ini jika Anda tidak memintanya.",
		"Atur Ulang Kata Sandi",
		link,
	)
	if err := s.mailer.Send(ctx, []string{email}, "[THC-VMS] Atur Ulang Kata Sandi", text, htmlBody); err != nil {
		slog.Warn("auth: password-reset mail failed", "error", err)
	}
}

// recordPasswordReset appends one user.update row best-effort for both legs
// of the flow, mirroring the self-service audit shape: the source names this
// flow, fields names the single rotated field, and no token, digest, or
// password ever enters the metadata. A failed write is logged and never
// fails the request, and a nil writer disables the trail.
func (s *Service) recordPasswordReset(ctx context.Context, userID domain.UUID) {
	if s.audit == nil {
		return
	}
	ip, userAgent := loginMeta(ctx)
	if _, err := s.audit.Append(ctx, domain.AuditEntry{
		ActorID:   &userID,
		Action:    domain.AuditActionUserUpdate,
		Entity:    domain.AuditEntityUser,
		EntityID:  &userID,
		IP:        ip,
		UserAgent: userAgent,
		Metadata: map[string]string{
			"source": "password-reset",
			"fields": "password",
		},
	}); err != nil {
		slog.Warn("auth: audit password reset failed", "user_id", string(userID), "error", err)
	}
}
