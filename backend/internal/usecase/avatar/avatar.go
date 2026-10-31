// Package avatar implements the authenticated avatar read usecase behind
// GET /api/v1/avatars/{id}. It exists because a stored avatar value is an
// absolute URL of our private bucket: presigning it binds the internal storage
// host into the signature, so a browser outside the Docker network cannot
// resolve it. The read path therefore streams the bytes through the API host
// instead of handing out a URL, mirroring the scoped GET /visits/{id}/file
// read. Raw stored URLs never leave this package.
package avatar

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"thc-vms/backend/internal/domain"
)

// Actor is the authenticated caller of an avatar read. LocationID is nil for
// super_admin and vendor accounts.
type Actor struct {
	ID         domain.UUID
	Role       domain.RoleName
	LocationID *domain.UUID
}

// Stream is the resolved, ready-to-serve avatar payload: the open bucket body
// plus the headers the HTTP layer serves it with. The handler owns closing
// Content.
type Stream struct {
	Content     io.ReadCloser
	Size        int64
	ContentType string
	ModTime     time.Time
	ETag        string
}

// Deps bundles the collaborators in one named struct so the constructor keeps a
// single parameter.
type Deps struct {
	Users   domain.UserRepository
	Objects domain.ObjectReader
}

// Service is the avatar read usecase.
type Service struct {
	users   domain.UserRepository
	objects domain.ObjectReader
}

// NewService wires the collaborators.
func NewService(d Deps) *Service {
	return &Service{users: d.Users, objects: d.Objects}
}

// allowedContentTypes is the closed set an avatar may be served as. Anything
// else fails closed: a stored object must never turn the endpoint into a
// generic file proxy.
var allowedContentTypes = map[string]struct{}{
	"image/jpeg": {},
	"image/png":  {},
	"image/webp": {},
}

// avatarNotFound is the fail-closed 404 for every unreadable avatar: unknown,
// foreign, blank, tampered or unsupported. It wraps ErrNotFound so errors.Is
// keeps working while the message never discloses whether the account exists.
func avatarNotFound() error {
	return &domain.AppError{
		Status:  http.StatusNotFound,
		Code:    "NOT_FOUND",
		Message: "Foto profil tidak tersedia.",
		Err:     domain.ErrNotFound,
	}
}

// ResolveAvatarStream loads the target account, applies the read scope, and
// streams its stored avatar. The order is the security contract: identity is
// refused first, the account is loaded next, the scope predicate runs before
// storage is touched, and only then is the stored URL reversed and opened.
// Every refusal is the same 404 so the endpoint never leaks existence.
func (s *Service) ResolveAvatarStream(ctx context.Context, actor Actor, targetID domain.UUID) (Stream, error) {
	if actor.ID == "" {
		return Stream{}, domain.ErrUnauthorized
	}
	if s.users == nil {
		return Stream{}, avatarNotFound()
	}
	target, err := s.users.FindByID(ctx, targetID)
	if err != nil {
		return Stream{}, err
	}
	if !canReadAvatar(actor, target) {
		return Stream{}, avatarNotFound()
	}
	stored := strings.TrimSpace(target.AvatarURL)
	if stored == "" || s.objects == nil {
		return Stream{}, avatarNotFound()
	}
	key, err := s.objects.ObjectKeyFromStoredURL(stored)
	if err != nil {
		slog.Warn("avatar: reverse stored avatar URL failed", "error", err)
		return Stream{}, avatarNotFound()
	}
	if !strings.HasPrefix(key, "profile_photos/") || strings.Contains(key, "..") {
		return Stream{}, avatarNotFound()
	}
	content, err := s.objects.OpenObject(ctx, key)
	if err != nil {
		slog.Warn("avatar: open object failed", "error", err)
		if errors.Is(err, domain.ErrNotFound) {
			return Stream{}, avatarNotFound()
		}
		return Stream{}, err
	}
	contentType := normalizeContentType(content.ContentType)
	if _, ok := allowedContentTypes[contentType]; !ok {
		content.Content.Close()
		return Stream{}, avatarNotFound()
	}
	return Stream{
		Content:     content.Content,
		Size:        content.Size,
		ContentType: contentType,
		ModTime:     content.ModTime,
		ETag:        etagFor(key, content.Size, content.ModTime),
	}, nil
}

// canReadAvatar applies the fail-closed read scope: the caller's own avatar,
// any avatar for super_admin, or an avatar of the same branch. Vendor accounts
// carry no location, so a vendor only ever sees itself.
func canReadAvatar(actor Actor, target domain.User) bool {
	if actor.ID == target.ID {
		return true
	}
	if domain.IsSuperAdminRole(actor.Role) {
		return true
	}
	return actor.LocationID != nil && target.LocationID != nil && *actor.LocationID == *target.LocationID
}

// normalizeContentType strips any parameters and case so the allowlist compare
// is stable against values such as "image/jpeg; charset=binary".
func normalizeContentType(raw string) string {
	base, _, _ := strings.Cut(raw, ";")
	return strings.ToLower(strings.TrimSpace(base))
}

// etagFor derives a stable, quoted ETag from the object key, size and
// modification time. It changes only when the served object does.
func etagFor(key string, size int64, modTime time.Time) string {
	sum := sha256.Sum256([]byte(key + ":" + strconv.FormatInt(size, 10) + ":" + modTime.UTC().Format(time.RFC3339Nano)))
	return fmt.Sprintf("%q", hex.EncodeToString(sum[:])[:32])
}
