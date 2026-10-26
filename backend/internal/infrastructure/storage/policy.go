package storage

import (
	"fmt"
	"strings"

	"thc-vms/backend/internal/config"
	"thc-vms/backend/internal/domain"
)

// policy is the immutable upload rule set distilled from config: the two byte
// ceilings and the ALLOWED_MIME_TYPES allow-list. It is resolved once at
// construction time so every validation is a map lookup and a comparison, and
// so a request can never widen the rules it is checked against.
//
// maxIngestBytes bounds the raw request body the server accepts (transport),
// while maxSizeBytes bounds what is actually persisted (storage). Compression
// happens between the two, which is why the transport ceiling is larger.
type policy struct {
	maxSizeBytes     int64
	maxIngestBytes   int64
	allowedMIMETypes map[string]struct{}
}

// newPolicy freezes one config.Upload into a policy. The allow-list is
// normalised to a set so a duplicated ALLOWED_MIME_TYPES entry costs nothing
// and lookups stay O(1).
func newPolicy(cfg config.Upload) policy {
	allowed := make(map[string]struct{}, len(cfg.AllowedMIMETypes))
	for _, mimeType := range cfg.AllowedMIMETypes {
		if normalised := normaliseMIMEType(mimeType); normalised != "" {
			allowed[normalised] = struct{}{}
		}
	}
	return policy{
		maxSizeBytes:     cfg.MaxSizeBytes,
		maxIngestBytes:   cfg.MaxIngestBytes,
		allowedMIMETypes: allowed,
	}
}

// validateUpload is the transport-stage upload policy, applied before any
// network call: a caller that gets a non-nil error here has spent no I/O and no
// bytes. MIME and nil-content refusals wrap domain.ErrStorageRejected (400
// STORAGE_REJECTED), while an over-ingest-ceiling payload is a
// domain.FileTooLargeError (413 FILE_TOO_LARGE); domain.FromError renders both.
func validateUpload(p policy, in domain.UploadRequest) error {
	if err := p.validateIngestSize(in.Size); err != nil {
		return err
	}
	if err := p.validateMIMEType(in.ContentType); err != nil {
		return err
	}
	if in.Content == nil {
		return reject("berkas tidak memiliki konten")
	}
	return nil
}

// validateIngestSize enforces the MAX_UPLOAD_INGEST_MB transport ceiling. The
// boundary is inclusive: a payload of exactly MaxIngestBytes is accepted, one
// byte more is not. A non-positive size is refused because a zero-length
// multipart part is always a client bug, never a legitimate document.
func (p policy) validateIngestSize(size int64) error {
	if size <= 0 {
		return reject(fmt.Sprintf("ukuran berkas tidak valid: %d byte", size))
	}
	if size > p.maxIngestBytes {
		return &domain.FileTooLargeError{Limit: p.maxIngestBytes}
	}
	return nil
}

// validateStoredSize enforces the MAX_UPLOAD_SIZE_MB ceiling on the bytes that
// would actually be persisted. It runs after compression, so a large raw upload
// may legitimately shrink below the limit; only the final size decides.
func (p policy) validateStoredSize(size int64) error {
	if size > p.maxSizeBytes {
		return &domain.FileTooLargeError{Limit: p.maxSizeBytes}
	}
	return nil
}

// validateMIMEType accepts only a member of the ALLOWED_MIME_TYPES set. An
// empty or unlisted type is a refusal, never a pass: the allow-list is
// exhaustive, so an absent type cannot be proven safe.
func (p policy) validateMIMEType(contentType string) error {
	normalised := normaliseMIMEType(contentType)
	if normalised == "" {
		return reject("tipe MIME berkas kosong")
	}
	if _, allowed := p.allowedMIMETypes[normalised]; !allowed {
		return reject(fmt.Sprintf("tipe MIME berkas tidak diizinkan: %s", normalised))
	}
	return nil
}

// normaliseMIMEType lowercases the type and drops any RFC 2045 parameter
// ("; charset=..."), which is a property of the parameter set, not of the media
// type. A blank or non-string result is reported as the empty string so the
// caller can refuse it.
func normaliseMIMEType(contentType string) string {
	base, _, _ := strings.Cut(contentType, ";")
	return strings.ToLower(strings.TrimSpace(base))
}

// reject wraps a policy diagnosis in the domain sentinel, keeping errors.Is
// working for callers while the message stays operator-readable.
func reject(reason string) error {
	return fmt.Errorf("%s: %w", reason, domain.ErrStorageRejected)
}
