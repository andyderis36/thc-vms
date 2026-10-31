package auth

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"unicode"

	"golang.org/x/crypto/bcrypt"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/validation"
)

// maxAvatarURLLength mirrors the visit file-URL ceiling (2048 characters) and
// the openapi avatar_url maxLength.
const maxAvatarURLLength = 2048

// SelfIdentity is the authenticated caller of a self-service profile write.
// It mirrors delivery's http.Identity but lives here so the usecase stays free
// of the delivery layer, the same split visit.Actor and gate.Actor use.
type SelfIdentity struct {
	UserID domain.UUID
	Role   domain.RoleName
}

// SelfUpdate is the tri-state body of PATCH /auth/me. A nil pointer means
// "field absent, keep the stored value"; a non-nil pointer means "replace".
// ClearAvatar exists because JSON null (the openapi way to remove the photo)
// and an absent member both decode to a nil *string — the delivery layer
// records the explicit null in ClearAvatar instead. Sending ClearAvatar and a
// non-nil AvatarURL in one request is rejected as ambiguous. A non-nil
// NewPassword rotates the caller's own password (all roles, including
// super_admin and dev-superadmin, through this same path); CurrentPassword
// must then carry the current password as takeover proof.
type SelfUpdate struct {
	Name            *string
	Phone           *string
	AvatarURL       *string
	ClearAvatar     bool
	NewPassword     *string
	CurrentPassword *string
}

// selfValidation builds the 400 VALIDATION_ERROR the delivery layer renders for
// a rejected self-service field value (openapi PATCH /auth/me 400).
func selfValidation(message string) *domain.AppError {
	return &domain.AppError{Status: http.StatusBadRequest, Code: "VALIDATION_ERROR", Message: message}
}

// selfForbidden builds the 403 FORBIDDEN naming the field a role may not edit.
func selfForbidden(message string) *domain.AppError {
	return &domain.AppError{Status: http.StatusForbidden, Code: "FORBIDDEN", Message: message}
}

// UpdateSelf applies the caller's own profile change and returns the refreshed
// projection. The current row is read first so locked fields keep their stored
// values and the audit entry can name the old name. The role policy gate runs
// before any write, so a refused field leaves the database untouched. Exactly
// one UpdateProfile call is made per accepted request.
func (s *Service) UpdateSelf(ctx context.Context, actor SelfIdentity, in SelfUpdate) (Profile, error) {
	if s.users == nil || s.profiles == nil {
		return Profile{}, domain.FromError(errUnwired)
	}
	current, err := s.users.FindByID(ctx, actor.UserID)
	if err != nil {
		return Profile{}, domain.FromError(err)
	}
	if in.Name == nil && in.Phone == nil && in.AvatarURL == nil && !in.ClearAvatar && in.NewPassword == nil {
		return Profile{}, selfValidation("Tidak ada perubahan yang diberikan.")
	}
	if in.ClearAvatar && in.AvatarURL != nil {
		return Profile{}, selfValidation("Foto profil tidak dapat diisi dan dihapus sekaligus.")
	}

	finalName := current.Name
	if in.Name != nil {
		if !canEdit(actor.Role, FieldName) {
			return Profile{}, selfForbidden("Field name hanya dapat diubah oleh super_admin.")
		}
		name, err := validateSelfName(*in.Name)
		if err != nil {
			return Profile{}, err
		}
		finalName = name
	}

	finalPhone := current.Phone
	if in.Phone != nil {
		if !canEdit(actor.Role, FieldPhone) {
			return Profile{}, selfForbidden("Field phone tidak dapat diubah untuk role ini.")
		}
		phone, err := validateSelfPhone(*in.Phone)
		if err != nil {
			return Profile{}, err
		}
		finalPhone = phone
	}

	finalAvatar := current.AvatarURL
	switch {
	case in.ClearAvatar:
		if !canEdit(actor.Role, FieldAvatarURL) {
			return Profile{}, selfForbidden("Field avatar_url tidak dapat diubah untuk role ini.")
		}
		finalAvatar = ""
	case in.AvatarURL != nil:
		if !canEdit(actor.Role, FieldAvatarURL) {
			return Profile{}, selfForbidden("Field avatar_url tidak dapat diubah untuk role ini.")
		}
		avatar, err := s.validateSelfAvatarURL(actor.UserID, *in.AvatarURL)
		if err != nil {
			return Profile{}, err
		}
		finalAvatar = avatar
	}

	newHash, passwordChanged, err := s.resolveSelfPassword(ctx, current, in.NewPassword, in.CurrentPassword)
	if err != nil {
		return Profile{}, err
	}

	// The previous photo is captured before the row write: its object may only
	// be reclaimed once the commit succeeds (row first, object second).
	oldAvatarURL := current.AvatarURL

	updated, err := s.profiles.UpdateProfile(ctx, actor.UserID, domain.ProfileUpdate{
		Name:         finalName,
		Phone:        finalPhone,
		AvatarURL:    finalAvatar,
		PasswordHash: newHash,
	})
	if err != nil {
		return Profile{}, domain.FromError(err)
	}
	s.deleteReplacedAvatar(ctx, actor.UserID, oldAvatarURL, finalAvatar)
	s.recordSelfUpdate(ctx, actor.UserID, current.Name, finalName, current.Phone, finalPhone, current.AvatarURL, finalAvatar, passwordChanged)
	return s.profile(ctx, updated)
}

// deleteReplacedAvatar reclaims the storage object behind the previous avatar
// after a successful profile commit. It is strictly best-effort: the row is
// already written, so a failed delete is logged and the request still succeeds
// (the same log-and-continue shape as the audit trail). Nothing is deleted when
// the old URL is blank or the storage port is unwired, and never when the old
// and new URLs reverse to the same object key — a same-filename upload
// overwrites that key in place via PutObject, so deleting it would destroy the
// photo just stored. The comparison runs on recovered keys, never on raw URLs,
// because avatar read URLs carry a cache-busting version (avatarpath) that
// changes while the underlying object key stays the same.
func (s *Service) deleteReplacedAvatar(ctx context.Context, userID domain.UUID, oldURL, newURL string) {
	if s.storage == nil || strings.TrimSpace(oldURL) == "" {
		return
	}
	oldKey, err := s.storage.ObjectKeyFromStoredURL(oldURL)
	if err != nil {
		slog.Warn("auth: reverse old avatar URL failed", "user_id", string(userID), "error", err)
		return
	}
	if newURL != "" {
		newKey, err := s.storage.ObjectKeyFromStoredURL(newURL)
		if err != nil {
			slog.Warn("auth: reverse new avatar URL failed", "user_id", string(userID), "error", err)
			return
		}
		if newKey == oldKey {
			return
		}
	}
	if err := s.storage.DeleteObject(ctx, oldKey); err != nil {
		slog.Warn("auth: delete replaced avatar failed", "user_id", string(userID), "old_key", oldKey, "error", err)
	}
}

// resolveSelfPassword validates a self-service password rotation and mints
// the fresh bcrypt hash. A nil new password means "keep the stored hash" (""
// returned). Otherwise the current password is mandatory takeover proof:
// it is compared with bcrypt against the stored hash (wrong is 401, the same
// INVALID_CREDENTIALS shape as PATCH /users/:id self-reset, naming only the
// failure, never whether the account exists beyond what login already
// reveals), and the new value must pass the shared password policy (the same
// validation.ValidPassword the managed-user create enforces). Only the hash
// leaves this function; plaintext passwords are never logged or stored.
func (s *Service) resolveSelfPassword(ctx context.Context, current domain.User, newPassword, currentPassword *string) (string, bool, error) {
	if newPassword == nil {
		return "", false, nil
	}
	if strings.TrimSpace(*newPassword) == "" {
		return "", false, selfValidation("Password baru tidak boleh kosong.")
	}
	if currentPassword == nil || *currentPassword == "" {
		return "", false, selfValidation("Password saat ini wajib diisi untuk mengubah password sendiri.")
	}
	// FindByID carries no password hash (the profile projection never
	// selects it), so the stored hash is re-read through the login lookup,
	// which does. The email is normalised exactly like Login.
	Stored, err := s.users.FindByEmail(ctx, strings.ToLower(strings.TrimSpace(current.Email)))
	if err != nil {
		return "", false, domain.InvalidCredentials()
	}
	if err := bcrypt.CompareHashAndPassword([]byte(Stored.PasswordHash), []byte(*currentPassword)); err != nil {
		return "", false, &domain.AppError{Status: http.StatusUnauthorized, Code: "INVALID_CREDENTIALS", Message: "Password saat ini salah."}
	}
	if err := validation.ValidPassword(*newPassword); err != nil {
		return "", false, selfValidation(err.Error())
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(*newPassword), bcrypt.DefaultCost)
	if err != nil {
		return "", false, domain.FromError(err)
	}
	return string(hash), true, nil
}

// validateSelfName trims the proposed name and applies the shared account-name
// rules: non-blank, within NameMaxLength runes, and free of control characters.
func validateSelfName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" {
		return "", selfValidation("Nama tidak boleh kosong.")
	}
	if validation.RuneLen(name) > validation.NameMaxLength {
		return "", selfValidation("Nama maksimal " + strconv.Itoa(validation.NameMaxLength) + " karakter.")
	}
	if strings.IndexFunc(name, unicode.IsControl) >= 0 {
		return "", selfValidation("Nama mengandung karakter yang tidak diizinkan.")
	}
	return name, nil
}

// validateSelfPhone reuses the shared phone validator and normaliser: the
// stored value is always the canonical digit form, never the raw input.
func validateSelfPhone(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", selfValidation("Nomor telepon tidak boleh kosong.")
	}
	if validation.PhoneLengthViolation(trimmed) {
		return "", selfValidation("Nomor telepon harus 10–16 digit angka.")
	}
	if !validation.ValidPhone(trimmed) {
		return "", selfValidation("Nomor telepon tidak valid.")
	}
	return validation.NormalizePhone(trimmed), nil
}

// validateSelfAvatarURL proves the submitted avatar belongs to the caller's own
// upload namespace. The stored URL is reversed to its object key through the
// storage port (never parsed here), and that key must sit under the actor's
// ProfilePhotoOwnerPrefix. A foreign origin, a malformed URL, and another
// account's prefix are all validation failures.
func (s *Service) validateSelfAvatarURL(actorID domain.UUID, raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", selfValidation("Tautan foto profil tidak valid.")
	}
	if len(trimmed) > maxAvatarURLLength {
		return "", selfValidation("Tautan foto profil tidak valid: terlalu panjang.")
	}
	if s.storage == nil {
		return "", domain.FromError(errUnwired)
	}
	key, err := s.storage.ObjectKeyFromStoredURL(trimmed)
	if err != nil {
		return "", selfValidation("Tautan foto profil tidak valid.")
	}
	if !strings.HasPrefix(key, domain.ProfilePhotoOwnerPrefix(actorID)) {
		return "", selfValidation("Tautan foto profil bukan milik akun ini.")
	}
	return trimmed, nil
}

// recordSelfUpdate appends one user.update row best-effort, mirroring the login
// trail: a failed write is logged and never fails the request, and a nil writer
// disables the trail. Metadata names only the fields that actually changed;
// a name change also carries the old and new values because audit_log stores
// no name snapshot.
func (s *Service) recordSelfUpdate(ctx context.Context, userID domain.UUID, oldName, newName, oldPhone, newPhone, oldAvatar, newAvatar string, passwordChanged bool) {
	if s.audit == nil {
		return
	}
	metadata := map[string]string{"source": "self"}
	changed := make([]string, 0, 4)
	if oldName != newName {
		changed = append(changed, FieldName)
		metadata["old_name"] = oldName
		metadata["new_name"] = newName
	}
	if oldPhone != newPhone {
		changed = append(changed, FieldPhone)
	}
	if oldAvatar != newAvatar {
		changed = append(changed, FieldAvatarURL)
	}
	if passwordChanged {
		changed = append(changed, "password")
	}
	metadata["fields"] = strings.Join(changed, ",")
	ip, userAgent := loginMeta(ctx)
	if _, err := s.audit.Append(ctx, domain.AuditEntry{
		ActorID:   &userID,
		Action:    domain.AuditActionUserUpdate,
		Entity:    domain.AuditEntityUser,
		EntityID:  &userID,
		IP:        ip,
		UserAgent: userAgent,
		Metadata:  metadata,
	}); err != nil {
		slog.Warn("auth: audit self profile update failed", "user_id", string(userID), "error", err)
	}
}
