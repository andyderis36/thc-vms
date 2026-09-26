package storage

import (
	"fmt"
	"strings"

	"thc-vms/backend/internal/config"
	"thc-vms/backend/internal/domain"
)

// policy is the immutable upload rule set distilled from config: the byte
// ceiling from MAX_UPLOAD_SIZE_MB and the ALLOWED_MIME_TYPES allow-list. It is
// resolved once at construction time so every validation is a map lookup and a
// comparison, and so a request can never widen the rules it is checked against.
type policy struct {
	maxSizeBytes     int64
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
	return policy{maxSizeBytes: cfg.MaxSizeBytes, allowedMIMETypes: allowed}
}

// validateUpload is the whole upload policy, applied before any network call:
// a caller that gets a non-nil error here has spent no I/O and no bytes. Every
// refusal wraps domain.ErrStorageRejected so the delivery layer renders the
// mandated 400 STORAGE_REJECTED envelope via domain.FromError.
func validateUpload(p policy, in domain.UploadRequest) error {
	if err := p.validateSize(in.Size); err != nil {
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

// validateSize enforces the MAX_UPLOAD_SIZE_MB ceiling. The boundary is
// inclusive: a payload of exactly MaxSizeBytes is accepted, one byte more is
// not. A non-positive size is refused because a zero-length multipart part is
// always a client bug, never a legitimate document.
func (p policy) validateSize(size int64) error {
	if size <= 0 {
		return reject(fmt.Sprintf("ukuran berkas tidak valid: %d byte", size))
	}
	if size > p.maxSizeBytes {
		return reject(fmt.Sprintf("ukuran berkas %d byte melebihi batas %d byte", size, p.maxSizeBytes))
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
