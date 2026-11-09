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
	"profile_photos":     {},
	"work_photos":        {},
}

// ObjectKeyFromStoredURL reverses a stored absolute file URL back to its bucket
// object key. The bucket stays private (EnsureBucket sets no policy), so the
// raw URL in the database is never directly fetchable; read paths exchange it
// for a short-lived presigned URL and need the key back first.
//
// The host is a deployment detail, so it is deliberately ignored: a rollout
// moves the public base from a LAN IP to a tunnel hostname, and the URLs
// already stored in the database have to keep resolving. What binds a stored
// URL to our bucket is the bucket name appearing as a FULL path segment, so the
// key is always read from OUR OWN bucket and a foreign host can never cause a
// fetch of that foreign host.
//
// The recovered key must still match the "<directory>/<owner>/<file>" layout
// with no traversal segment, so "..", absolute or dot segments and unknown
// directories can never become a PresignedGetObject argument.
func (a *MinIOAdapter) ObjectKeyFromStoredURL(rawURL string) (string, error) {
	return objectKeyFromStoredURL(a.publicBaseURL, a.bucket, rawURL)
}

// objectKeyFromStoredURL is the pure, unit-testable core: base is the
// adapter's public base, bucket the adapter's own bucket name, raw the stored
// absolute URL.
//
// base is only a configuration sanity check: a public base that does not
// expose the bucket segment means the deployment is misconfigured, and
// refusing loudly beats silently 404-ing every stored file.
func objectKeyFromStoredURL(base, bucket, raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", fmt.Errorf("storage: tautan berkas kosong: %w", domain.ErrValidation)
	}
	base = strings.TrimRight(strings.TrimSpace(base), "/")
	if base == "" {
		return "", fmt.Errorf("storage: basis URL publik belum dikonfigurasi: %w", domain.ErrValidation)
	}
	bucket = strings.TrimSpace(bucket)
	if bucket == "" {
		return "", fmt.Errorf("storage: nama bucket belum dikonfigurasi: %w", domain.ErrValidation)
	}
	baseSegments, ok := storedURLPathSegments(base)
	if !ok || bucketSegmentIndex(baseSegments, bucket) < 0 {
		return "", fmt.Errorf("storage: basis URL publik %q tidak memuat nama bucket %q: %w", base, bucket, domain.ErrValidation)
	}
	segments, ok := storedURLPathSegments(trimmed)
	if !ok {
		return "", fmt.Errorf("storage: tautan berkas tidak valid: %w", domain.ErrValidation)
	}
	index := bucketSegmentIndex(segments, bucket)
	if index < 0 {
		return "", fmt.Errorf("storage: tautan di luar bucket %q: %w", bucket, domain.ErrValidation)
	}
	if index == len(segments)-1 {
		return "", fmt.Errorf("storage: tautan tanpa object key: %w", domain.ErrValidation)
	}
	key := strings.Join(segments[index+1:], "/")
	// The key must still be one of OUR OWN objects: the same layout
	// buildObjectKey writes, with no traversal and no unknown directory.
	if strings.Contains(key, "\\") {
		return "", fmt.Errorf("storage: tautan berkas tidak valid: %w", domain.ErrValidation)
	}
	parts := strings.Split(key, "/")
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
	return key, nil
}

// storedURLPathSegments extracts the path of an absolute http(s) URL and splits
// it into decoded segments.
//
// net/url is deliberately not used on the whole URL: stored file URLs carry
// literal spaces ("Surat Izin Kerja.pdf") and url.Parse is stricter than the
// data we actually store. The host is dropped on purpose, because a
// deployment moves its public base (LAN IP, tunnel hostname, CDN) without
// moving the objects, and the object key must survive that move.
func storedURLPathSegments(raw string) ([]string, bool) {
	scheme, rest, found := strings.Cut(raw, "://")
	if !found {
		return nil, false
	}
	if !strings.EqualFold(scheme, "http") && !strings.EqualFold(scheme, "https") {
		return nil, false
	}
	// A query string or fragment is never part of the key (stored URLs are
	// plain; a presigned URL accidentally written back would carry one).
	if i := strings.IndexAny(rest, "?#"); i >= 0 {
		rest = rest[:i]
	}
	authority, path, found := strings.Cut(rest, "/")
	if !found || authority == "" {
		return nil, false
	}
	// Decode %-escapes so the segments match what PutObject stored; an invalid
	// escape is itself a refusal, not a best-effort guess.
	decoded, err := url.PathUnescape(path)
	if err != nil {
		return nil, false
	}
	return strings.Split(strings.TrimPrefix(decoded, "/"), "/"), true
}

// bucketSegmentIndex returns the index of the first path segment that equals
// the bucket name exactly, or -1 when the path does not expose the bucket.
//
// Full-segment equality is the whole point: a sibling bucket whose name merely
// starts with ours ("thc-vms-bucket-evil") must never bind a URL to our
// bucket, because a prefix match would hand it the key.
func bucketSegmentIndex(segments []string, bucket string) int {
	for i, segment := range segments {
		if segment == bucket {
			return i
		}
	}
	return -1
}
