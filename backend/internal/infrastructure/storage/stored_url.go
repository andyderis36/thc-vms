package storage

import (
	"fmt"
	"net/url"
	"strings"

	"thc-vms/backend/internal/domain"
)

// allowedKeyDirectories is the exact directory vocabulary buildObjectKey can
// produce. A reversed key outside this set was never stored by this adapter,
// so it is refused rather than presigned.
var allowedKeyDirectories = map[string]struct{}{
	"assignment_letters": {},
	"id_cards":           {},
	"checkin_photos":     {},
}

// ObjectKeyFromStoredURL reverses a stored absolute file URL back to its bucket
// object key. The bucket stays private (EnsureBucket sets no policy), so the
// raw URL in the database is never directly fetchable; read paths exchange it
// for a short-lived presigned URL and need the key back first.
//
// The check is a strict prefix against the adapter's own publicBaseURL: a URL
// from any other origin is refused, and the recovered key must match the
// "<directory>/<owner>/<file>" layout with no traversal segment, so "..",
// absolute or dot segments and unknown directories can never become a
// PresignedGetObject argument.
func (a *MinIOAdapter) ObjectKeyFromStoredURL(rawURL string) (string, error) {
	return objectKeyFromStoredURL(a.publicBaseURL, rawURL)
}

// objectKeyFromStoredURL is the pure, unit-testable core: base is the
// adapter's public base, raw is the stored absolute URL.
func objectKeyFromStoredURL(base, raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", fmt.Errorf("storage: tautan berkas kosong: %w", domain.ErrValidation)
	}
	base = strings.TrimRight(strings.TrimSpace(base), "/")
	if base == "" {
		return "", fmt.Errorf("storage: basis URL publik belum dikonfigurasi: %w", domain.ErrValidation)
	}
	if trimmed != base && !strings.HasPrefix(trimmed, base+"/") {
		return "", fmt.Errorf("storage: tautan di luar bucket %q: %w", base, domain.ErrValidation)
	}
	rest := strings.TrimPrefix(trimmed, base)
	rest = strings.TrimPrefix(rest, "/")
	// A query string or fragment is never part of the key (stored URLs are
	// plain; a presigned URL accidentally written back would carry one).
	if i := strings.IndexAny(rest, "?#"); i >= 0 {
		rest = rest[:i]
	}
	if rest == "" {
		return "", fmt.Errorf("storage: tautan tanpa object key: %w", domain.ErrValidation)
	}
	// Decode %-escapes so the key matches what PutObject stored; an invalid
	// escape is itself a refusal, not a best-effort guess.
	decoded, err := url.PathUnescape(rest)
	if err != nil {
		return "", fmt.Errorf("storage: tautan berkas tidak valid: %w", domain.ErrValidation)
	}
	if strings.Contains(decoded, "\\") {
		return "", fmt.Errorf("storage: tautan berkas tidak valid: %w", domain.ErrValidation)
	}
	parts := strings.Split(decoded, "/")
	if len(parts) < 3 {
		return "", fmt.Errorf("storage: tautan di luar layout bucket: %w", domain.ErrValidation)
	}
	if _, known := allowedKeyDirectories[parts[0]]; !known {
		return "", fmt.Errorf("storage: direktori berkas tidak dikenal: %w", domain.ErrValidation)
	}
	for _, segment := range parts {
		if segment == "" || segment == "." || segment == ".." || strings.Contains(segment, "..") {
			return "", fmt.Errorf("storage: tautan berkas tidak valid: %w", domain.ErrValidation)
		}
	}
	return decoded, nil
}
