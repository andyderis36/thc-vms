package auth

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"golang.org/x/crypto/bcrypt"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/validation"
)

// EmailChangeClaims is the verified identity a confirm token carries: the
// account that requested the move plus the frozen old -> new address pair.
type EmailChangeClaims struct {
	UserID   domain.UUID
	OldEmail string
	NewEmail string
}

// EmailChangeTokens mints and verifies the stateless tokens confirming an
// email-address change. It is satisfied structurally by the
// infrastructure/emailchange service through a thin adapter at the composition
// root, keeping this package free of the infrastructure layer; tests use a map
// fake. Mint binds one account to one old -> new move, Verify returns the
// binding or fails closed for expired, tampered or otherwise unverifiable
// tokens.
type EmailChangeTokens interface {
	Mint(userID domain.UUID, oldEmail, newEmail string) (string, error)
	Verify(token string) (EmailChangeClaims, error)
}

// emailChangeLinkInvalid is the single response every confirm failure renders:
// expired, tampered, cross-user, stale-row and taken-address cases are
// byte-identical so the endpoint can never become an account oracle. The cause
// stays server-side (slog); the client only sees the link message.
func emailChangeLinkInvalid() *domain.AppError {
	return &domain.AppError{
		Status:  http.StatusUnauthorized,
		Code:    "UNAUTHORIZED",
		Message: "Tautan tidak valid atau kedaluwarsa.",
		Err:     domain.ErrUnauthorized,
	}
}

// RequestEmailChange starts an email-address change for one account: it
// resolves the row strictly by userID (never by a supplied address), checks
// the old address binding, the new address shape and the current-password
// takeover proof, then mints a token binding user -> old -> new and mails the
// verification link to the NEW inbox. The returned token lets the caller
// deliver the link through another channel; it must never be logged.
//
// Nothing is written: a taken new address is deliberately NOT reported here
// (the request succeeds exactly like the free case) so the endpoint reveals
// nothing about address ownership; the freeness check happens at confirm
// time. Mail delivery is best-effort: a mailer failure is logged and the
// token still returns.
func (s *Service) RequestEmailChange(ctx context.Context, userID domain.UUID, oldEmail, newEmail, currentPassword string) (string, error) {
	if s.users == nil || s.emailTokens == nil {
		return "", domain.FromError(errUnwired)
	}
	current, err := s.users.FindByID(ctx, userID)
	if err != nil {
		return "", domain.FromError(err)
	}
	stored := strings.ToLower(strings.TrimSpace(current.Email))
	if strings.ToLower(strings.TrimSpace(oldEmail)) != stored {
		return "", &domain.AppError{Status: http.StatusBadRequest, Code: "VALIDATION_ERROR", Message: "Email lama tidak sesuai dengan data akun."}
	}
	normalised := strings.ToLower(strings.TrimSpace(newEmail))
	if !validation.ValidEmail(normalised) {
		return "", &domain.AppError{Status: http.StatusBadRequest, Code: "VALIDATION_ERROR", Message: "Alamat email baru tidak valid."}
	}
	if normalised == stored {
		return "", &domain.AppError{Status: http.StatusBadRequest, Code: "VALIDATION_ERROR", Message: "Alamat email baru sama dengan email saat ini."}
	}
	if strings.TrimSpace(currentPassword) == "" {
		return "", &domain.AppError{Status: http.StatusBadRequest, Code: "VALIDATION_ERROR", Message: "Password saat ini wajib diisi untuk mengganti email."}
	}
	// FindByID carries no password hash (the profile projection never selects
	// it), so the stored hash is re-read through the login lookup, exactly
	// like the self-service password rotation. A missing row or a bad
	// password both render the same fixed 401: the caller is already
	// authenticated, but the message must not distinguish the cases.
	withHash, err := s.users.FindByEmail(ctx, stored)
	if err != nil {
		return "", &domain.AppError{Status: http.StatusUnauthorized, Code: "INVALID_CREDENTIALS", Message: "Password saat ini salah."}
	}
	if err := bcrypt.CompareHashAndPassword([]byte(withHash.PasswordHash), []byte(currentPassword)); err != nil {
		return "", &domain.AppError{Status: http.StatusUnauthorized, Code: "INVALID_CREDENTIALS", Message: "Password saat ini salah."}
	}
	token, err := s.emailTokens.Mint(userID, current.Email, normalised)
	if err != nil {
		slog.Warn("auth: email-change mint failed", "user_id", string(userID), "error", err)
		return "", &domain.AppError{Status: http.StatusInternalServerError, Code: "INTERNAL_ERROR", Message: "Terjadi kesalahan pada server."}
	}
	s.sendEmailVerification(ctx, normalised, token)
	return token, nil
}

// ConfirmEmailChange completes an email-address change: it verifies the
// token, binds the token subject to the caller AND the token old_email to the
// current row (so a replay after the flip finds a mismatch and fails),
// re-checks that the new address is still free, then flips the stored email
// through the profile port. The audit trail and BOTH notices (the verbatim
// security copy to the old inbox, the success copy to the new one) are
// best-effort: their failure is logged and the flip still stands. A nil
// mailer or audit writer disables only its own fan-out.
func (s *Service) ConfirmEmailChange(ctx context.Context, userID domain.UUID, token string) (Profile, error) {
	if s.users == nil || s.profiles == nil || s.emailTokens == nil {
		return Profile{}, domain.FromError(errUnwired)
	}
	claims, err := s.emailTokens.Verify(token)
	if err != nil {
		slog.Warn("auth: email-change confirm rejected", "user_id", string(userID), "reason", "verify", "error", err)
		return Profile{}, emailChangeLinkInvalid()
	}
	if claims.UserID != userID {
		slog.Warn("auth: email-change confirm rejected", "user_id", string(userID), "reason", "user_mismatch")
		return Profile{}, emailChangeLinkInvalid()
	}
	current, err := s.users.FindByID(ctx, userID)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			slog.Warn("auth: email-change confirm rejected", "user_id", string(userID), "reason", "account_gone")
			return Profile{}, emailChangeLinkInvalid()
		}
		return Profile{}, domain.FromError(err)
	}
	if !strings.EqualFold(strings.TrimSpace(current.Email), strings.TrimSpace(claims.OldEmail)) {
		slog.Warn("auth: email-change confirm rejected", "user_id", string(userID), "reason", "old_email_mismatch")
		return Profile{}, emailChangeLinkInvalid()
	}
	normalised := strings.ToLower(strings.TrimSpace(claims.NewEmail))
	if !validation.ValidEmail(normalised) || normalised == strings.ToLower(strings.TrimSpace(current.Email)) {
		slog.Warn("auth: email-change confirm rejected", "user_id", string(userID), "reason", "new_email_unusable")
		return Profile{}, emailChangeLinkInvalid()
	}
	if _, err := s.users.FindByEmail(ctx, normalised); err == nil {
		slog.Warn("auth: email-change confirm rejected", "user_id", string(userID), "reason", "new_email_taken")
		return Profile{}, emailChangeLinkInvalid()
	} else if !errors.Is(err, domain.ErrNotFound) {
		return Profile{}, domain.FromError(err)
	}
	updated, err := s.profiles.UpdateProfile(ctx, userID, domain.ProfileUpdate{
		Name:      current.Name,
		Phone:     current.Phone,
		AvatarURL: current.AvatarURL,
		Email:     normalised,
	})
	if err != nil {
		if errors.Is(err, domain.ErrConflict) {
			slog.Warn("auth: email-change confirm rejected", "user_id", string(userID), "reason", "new_email_taken_race")
			return Profile{}, emailChangeLinkInvalid()
		}
		return Profile{}, domain.FromError(err)
	}
	s.recordEmailChange(ctx, userID, current.Email, normalised)
	s.sendEmailChangedNotices(ctx, current.Email, normalised)
	return s.profile(ctx, updated)
}

// sendEmailVerification mails the confirm link to the NEW inbox only. It is
// strictly best-effort: a send failure is logged and the request still
// succeeds, and a nil mailer only skips the notice. The token travels in the
// body (the holder proves control of the new inbox); it is never logged.
func (s *Service) sendEmailVerification(ctx context.Context, newEmail, token string) {
	if s.mailer == nil {
		slog.Warn("auth: email-change verification mail skipped", "reason", "mailer_unwired")
		return
	}
	link := "/verify-email?token=" + token
	if s.frontendBaseURL != "" {
		link = s.frontendBaseURL + link
	}
	text := fmt.Sprintf("Klik tautan berikut untuk mengonfirmasi perubahan alamat email akun THC-VMS Anda menjadi %s:\n%s\nTautan ini kedaluwarsa dalam 60 menit. Abaikan email ini jika Anda tidak memintanya.", newEmail, link)
	htmlBody := domain.RenderBrandedActionEmail(
		"Verifikasi Alamat Email Baru",
		fmt.Sprintf("Klik tombol berikut untuk mengonfirmasi perubahan alamat email akun THC-VMS Anda menjadi %s. Tautan ini kedaluwarsa dalam 60 menit. Abaikan email ini jika Anda tidak memintanya.", newEmail),
		"Verifikasi Email",
		link,
	)
	if err := s.mailer.Send(ctx, []string{newEmail}, "[THC-VMS] Verifikasi Alamat Email Baru", text, htmlBody); err != nil {
		slog.Warn("auth: email-change verification mail failed", "error", err)
	}
}

// sendEmailChangedNotices queues BOTH post-flip notices: the verbatim
// security copy to the OLD inbox (so a takeover victim learns where to turn)
// and the success copy to the NEW one. Each send is independent and
// best-effort: one failing must not cancel the other nor the flip.
func (s *Service) sendEmailChangedNotices(ctx context.Context, oldEmail, newEmail string) {
	if s.mailer == nil {
		return
	}
	oldText := fmt.Sprintf("Email akun THC-VMS Anda baru saja diganti menjadi %s. Jika ini bukan Anda, segera hubungi admin dan ganti kata sandi.", newEmail)
	if err := s.mailer.Send(ctx, []string{oldEmail}, "[THC-VMS] Email Akun Berubah",
		oldText, domain.RenderBrandedActionEmail("Email Akun Berubah", oldText, "", "")); err != nil {
		slog.Warn("auth: email-change old-address notice failed", "error", err)
	}
	newText := fmt.Sprintf("Email akun THC-VMS Anda telah berhasil diubah menjadi %s. Gunakan alamat ini untuk masuk mulai sekarang.", newEmail)
	loginLink := "/login"
	if s.frontendBaseURL != "" {
		loginLink = s.frontendBaseURL + loginLink
	}
	if err := s.mailer.Send(ctx, []string{newEmail}, "[THC-VMS] Email Akun Berhasil Diubah",
		newText, domain.RenderBrandedActionEmail("Email Akun Berhasil Diubah", newText, "Masuk", loginLink)); err != nil {
		slog.Warn("auth: email-change new-address notice failed", "error", err)
	}
}

// recordEmailChange appends the user.update flip trail best-effort, mirroring
// the self-service audit shape: the source names this flow, fields names the
// single flipped field, and the old/new pair travels in metadata (addresses,
// never tokens or passwords). A failed write is logged and never fails the
// confirm, and a nil writer disables the trail.
func (s *Service) recordEmailChange(ctx context.Context, userID domain.UUID, oldEmail, newEmail string) {
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
			"source":    "self-email-change",
			"fields":    "email",
			"old_email": oldEmail,
			"new_email": newEmail,
		},
	}); err != nil {
		slog.Warn("auth: audit email change failed", "user_id", string(userID), "error", err)
	}
}
