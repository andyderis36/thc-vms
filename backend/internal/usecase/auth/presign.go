package auth

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"thc-vms/backend/internal/domain"
)

// defaultPresignTTL mirrors the config default (S3_PRESIGN_TTL_MINUTES=15): the
// fallback when a Service is built without WithFileLinks or is given a
// non-positive TTL. It duplicates the constant rather than importing config so
// the usecase layer never depends on the infrastructure config package.
const defaultPresignTTL = 15 * time.Minute

// WithFileLinks wires object storage for the read-path avatar URL and returns
// the service for chaining at the composition root. A non-positive ttl is
// clamped to the default so the adapter's expiry<=0 refusal can never be
// triggered by configuration. Existing auth.NewService call sites keep
// compiling: an unwired store simply blanks avatar_url.
func (s *Service) WithFileLinks(store domain.IStorageService, ttl time.Duration) *Service {
	s.storage = store
	if ttl <= 0 {
		ttl = defaultPresignTTL
	}
	s.presignTTL = ttl
	return s
}

// effectivePresignTTL is the expiry forwarded to PresignedURL. It is always
// positive even for Services built without WithFileLinks.
func (s *Service) effectivePresignTTL() time.Duration {
	if s.presignTTL <= 0 {
		return defaultPresignTTL
	}
	return s.presignTTL
}

// presignStoredURL exchanges one stored absolute avatar URL for a short-lived
// presigned URL of our own bucket. An absent value or an unwired store stays
// blank; a reversal or signing failure is logged and also blanks the field, so
// a storage outage never turns a readable profile into a 500 and the raw
// private-bucket address never reaches the client.
func (s *Service) presignStoredURL(ctx context.Context, stored string) string {
	trimmed := strings.TrimSpace(stored)
	if trimmed == "" || s.storage == nil {
		return ""
	}
	key, err := s.storage.ObjectKeyFromStoredURL(trimmed)
	if err != nil {
		slog.Warn("auth: reverse stored avatar URL failed", "error", err)
		return ""
	}
	signed, err := s.storage.PresignedURL(ctx, key, s.effectivePresignTTL())
	if err != nil {
		slog.Warn("auth: presign avatar failed", "error", err)
		return ""
	}
	return strings.TrimSpace(signed)
}
