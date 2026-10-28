package auth

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"unicode"

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
// non-nil AvatarURL in one request is rejected as ambiguous.
type SelfUpdate struct {
	Name        *string
	Phone       *string
	AvatarURL   *string
	ClearAvatar bool
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
	if in.Name == nil && in.Phone == nil && in.AvatarURL == nil && !in.ClearAvatar {
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

	updated, err := s.profiles.UpdateProfile(ctx, actor.UserID, domain.ProfileUpdate{
		Name:      finalName,
		Phone:     finalPhone,
		AvatarURL: finalAvatar,
	})
	if err != nil {
		return Profile{}, domain.FromError(err)
	}
	s.recordSelfUpdate(ctx, actor.UserID, current.Name, finalName, current.Phone, finalPhone, current.AvatarURL, finalAvatar)
	return s.profile(ctx, updated)
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
func (s *Service) recordSelfUpdate(ctx context.Context, userID domain.UUID, oldName, newName, oldPhone, newPhone, oldAvatar, newAvatar string) {
	if s.audit == nil {
		return
	}
	metadata := map[string]string{"source": "self"}
	changed := make([]string, 0, 3)
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
