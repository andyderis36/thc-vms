package handlers

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"thc-vms/backend/internal/domain"
)

// defaultAvatarPresignTTL mirrors the config default (S3_PRESIGN_TTL_MINUTES=15)
// and the auth usecase fallback, so a handler built without WithFileLinks still
// mints a bounded link instead of trusting a zero expiry.
const defaultAvatarPresignTTL = 15 * time.Minute

// avatarLinker is the shared read-path presigner embedded by the back-office
// handlers that serve account rows. Stored avatar values are absolute URLs of
// our private bucket (or SQL NULL, read as ""), which must never reach the
// client verbatim: every list/detail projection exchanges one for a
// short-lived presigned URL instead.
type avatarLinker struct {
	storage domain.IStorageService
	ttl     time.Duration
}

// withFileLinks wires object storage for avatar links. A non-positive ttl is
// clamped to the default so the adapter's expiry<=0 refusal is unreachable
// from configuration; an unwired linker keeps every avatar null.
func (l *avatarLinker) withFileLinks(store domain.IStorageService, ttl time.Duration) {
	l.storage = store
	if ttl <= 0 {
		ttl = defaultAvatarPresignTTL
	}
	l.ttl = ttl
}

// effectiveTTL returns the expiry handed to PresignedURL, always positive.
func (l *avatarLinker) effectiveTTL() time.Duration {
	if l.ttl <= 0 {
		return defaultAvatarPresignTTL
	}
	return l.ttl
}

// avatarURL exchanges one stored avatar URL for a presigned URL of our own
// bucket. An absent value or an unwired store stays null; a reversal or
// signing failure also stays null, because a storage outage must never turn a
// readable account list into a 500 and the raw private-bucket address must
// never leak as a fallback. Logs carry the error only, never the stored URL.
func (l *avatarLinker) avatarURL(ctx context.Context, stored string) *string {
	trimmed := strings.TrimSpace(stored)
	if trimmed == "" || l.storage == nil {
		return nil
	}
	key, err := l.storage.ObjectKeyFromStoredURL(trimmed)
	if err != nil {
		slog.Warn("users: reverse stored avatar URL failed", "error", err)
		return nil
	}
	signed, err := l.storage.PresignedURL(ctx, key, l.effectiveTTL())
	if err != nil {
		slog.Warn("users: presign avatar failed", "error", err)
		return nil
	}
	signed = strings.TrimSpace(signed)
	if signed == "" {
		return nil
	}
	return &signed
}

// WithFileLinks wires object storage for avatar links and returns the handler
// for chaining at the composition root.
func (h *UserHandler) WithFileLinks(store domain.IStorageService, ttl time.Duration) *UserHandler {
	h.avatarLinker.withFileLinks(store, ttl)
	return h
}

// WithFileLinks wires object storage for avatar links and returns the handler
// for chaining at the composition root.
func (h *SuperAdminHandler) WithFileLinks(store domain.IStorageService, ttl time.Duration) *SuperAdminHandler {
	h.avatarLinker.withFileLinks(store, ttl)
	return h
}
