package storage

import (
	"io"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/infrastructure/imagecompress"
)

// prepareStoredContent turns one uploaded stream into the exact bytes that may
// be persisted: it reads within the ingest ceiling, compresses images and large
// PDFs, and then verifies the result against the stored ceiling. It is pure
// (no bucket, no clock, no config lookup) so the whole compress-then-check
// contract is unit-testable without MinIO.
//
// The returned mimeType is the type the stored object actually is: image
// compression may normalise it, while PDFs and untouched payloads keep theirs.
func prepareStoredContent(in domain.UploadRequest, p policy) (content []byte, mimeType string, err error) {
	if in.Content == nil {
		return nil, "", reject("berkas tidak memiliki konten")
	}

	// Read one byte past the ceiling so an oversized stream is detectable
	// without ever buffering the whole hostile payload.
	content, err = io.ReadAll(io.LimitReader(in.Content, p.maxIngestBytes+1))
	if err != nil {
		return nil, "", reject("berkas tidak dapat dibaca")
	}
	if int64(len(content)) > p.maxIngestBytes {
		return nil, "", &domain.FileTooLargeError{Limit: p.maxIngestBytes}
	}
	if len(content) == 0 {
		return nil, "", reject("berkas tidak memiliki konten")
	}

	mimeType = normaliseMIMEType(in.ContentType)
	switch mimeType {
	case "image/jpeg", "image/png":
		content, mimeType, _ = imagecompress.Prepare(content, mimeType)
	case "application/pdf":
		if int64(len(content)) > p.maxSizeBytes {
			optimised, optimizeErr := imagecompress.OptimizePDF(content)
			if optimizeErr != nil {
				// The original is over the stored ceiling, so it must never be
				// persisted as a fallback: a failed optimisation is a refusal.
				return nil, mimeType, &domain.FileTooLargeError{
					Limit: p.maxSizeBytes,
					Cause: optimizeErr,
				}
			}
			content = optimised
		}
	}

	if err := p.validateStoredSize(int64(len(content))); err != nil {
		return nil, "", err
	}
	return content, mimeType, nil
}
