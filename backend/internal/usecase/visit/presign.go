package visit

import (
	"context"
	"strings"
	"time"

	"thc-vms/backend/internal/domain"
)

// defaultPresignTTL mirrors the config default (S3_PRESIGN_TTL_MINUTES=15): the
// fallback when a Service is built without WithFileLinks or is given a
// non-positive TTL. It duplicates the constant rather than importing config so
// the usecase layer never depends on the infrastructure config package.
const defaultPresignTTL = 15 * time.Minute

// WithFileLinks wires object storage for read-path file URLs and returns the
// service for chaining at the composition root. A non-positive ttl is clamped
// to the default so the adapter's expiry<=0 refusal can never be triggered by
// configuration.
func (s *Service) WithFileLinks(store domain.IStorageService, ttl time.Duration) *Service {
	s.storage = store
	if ttl <= 0 {
		ttl = defaultPresignTTL
	}
	s.presignTTL = ttl
	return s
}

// effectivePresignTTL is the expiry forwarded to PresignedURL. It is always
// positive even for Services built without WithFileLinks (zero value falls
// back to the default).
func (s *Service) effectivePresignTTL() time.Duration {
	if s.presignTTL <= 0 {
		return defaultPresignTTL
	}
	return s.presignTTL
}

// presignStoredURL exchanges one stored absolute file URL for a short-lived
// presigned URL of our own bucket. An absent value stays absent; anything the
// storage port refuses (foreign origin, empty, traversal, presign failure, or
// an unwired storage) becomes absent too — never the raw third-party address.
// Reads therefore stay best-effort: a storage outage blanks the file links but
// never turns a readable visit into a 500, mirroring withGateTimes.
func (s *Service) presignStoredURL(ctx context.Context, raw *string) *string {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return nil
	}
	if s.storage == nil {
		return nil
	}
	key, err := s.storage.ObjectKeyFromStoredURL(*raw)
	if err != nil {
		return nil
	}
	signed, err := s.storage.PresignedURL(ctx, key, s.effectivePresignTTL())
	if err != nil || strings.TrimSpace(signed) == "" {
		return nil
	}
	return &signed
}

// withFileLinks enriches one ALREADY-AUTHORIZED visit with presigned file
// links for the GET /visits/{id} and GET /visits responses: the SPK letter
// plus every visitor's KTP photo and selfie. It runs after the scope check
// (GetVisit) or on rows the scoped filter already returned (ListVisits), so no
// new authz is introduced: whoever may see the visit may see its files, and a
// caller refused the visit never reaches this enrichment at all.
//
// Cost note: each link costs one HMAC-SHA256 presign with no batch API on the
// MinIO side, so a full list page pays up to (1 + 2*visitors) signs per row.
// The page is capped at 100 rows with typically 1-3 visitors, which keeps the
// worst case in the low hundreds of sub-millisecond local operations —
// correctness (no raw private URL may ever leave the backend) outweighs that
// bounded cost, and withGateTimes stays single-GET-only because ITS cost is
// extra SQL round trips, not local HMACs.
func (s *Service) withFileLinks(ctx context.Context, visit domain.VisitRequest) domain.VisitRequest {
	visit.AssignmentLetterURL = s.presignStoredURL(ctx, visit.AssignmentLetterURL)
	for i := range visit.Visitors {
		visit.Visitors[i].IDCardPhotoURL = s.presignStoredURL(ctx, visit.Visitors[i].IDCardPhotoURL)
		visit.Visitors[i].PhotoURL = s.presignStoredURL(ctx, visit.Visitors[i].PhotoURL)
	}
	return visit
}
