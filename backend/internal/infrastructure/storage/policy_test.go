package storage

import (
	"bytes"
	"errors"
	"testing"

	"thc-vms/backend/internal/config"
	"thc-vms/backend/internal/domain"
)

// mebibyte keeps the size arithmetic readable and byte-exact; the production
// limit comes from MAX_UPLOAD_SIZE_MB, never from a constant here.
const mebibyte = int64(1024 * 1024)

// localAllowlist mirrors the ALLOWED_MIME_TYPES value shipped in
// .env.example and docs/5. LOCAL_DEV.md section 4.1.
const localAllowlist = "application/pdf,image/jpeg,image/png"

// loadTestConfig routes the real config.Load through the environment so the
// policy tests exercise the very same MAX_UPLOAD_SIZE_MB / ALLOWED_MIME_TYPES
// parsing production uses, instead of a hand-built struct that could drift.
func loadTestConfig(t *testing.T, maxUploadMB, allowedMIMETypes string) *config.Config {
	t.Helper()
	t.Setenv("JWT_SECRET", "unit-test-only-signing-key")
	t.Setenv("MAX_UPLOAD_SIZE_MB", maxUploadMB)
	t.Setenv("ALLOWED_MIME_TYPES", allowedMIMETypes)
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("config.Load() must succeed for the test fixture: %v", err)
	}
	return cfg
}

// pngRequest is the smallest request that passes every policy check, so each
// rejection test varies exactly one field from a known-good baseline.
func pngRequest(size int64) domain.UploadRequest {
	return domain.UploadRequest{
		ObjectKey:   CategoryCheckinPhoto + "/8f1c1f2e-0000-4000-8000-000000000001",
		FileName:    "foto-pos.png",
		ContentType: "image/png",
		Size:        size,
		Content:     bytes.NewReader([]byte("fake-png-bytes")),
	}
}

// Given a 5 MB stored ceiling and a 20 MB ingest ceiling, when a 6.2 MB upload
// arrives, then the transport stage accepts it (compression may shrink it) and
// only the stored-size check refuses it; exactly the stored limit is accepted.
func TestUpload_StoredCeilingRejectsOnlyAfterCompression(t *testing.T) {
	cfg := loadTestConfig(t, "5", localAllowlist)
	storedLimit := cfg.Upload.MaxSizeBytes
	if storedLimit != 5*mebibyte {
		t.Fatalf("Given MAX_UPLOAD_SIZE_MB=5, the parsed limit must be 5 MiB, got %d", storedLimit)
	}
	p := newPolicy(cfg.Upload)

	oversize := pngRequest(6*mebibyte + 209*1024) // 6.2 MB
	if oversize.Size <= storedLimit {
		t.Fatalf("test fixture must exceed the stored limit, got %d <= %d", oversize.Size, storedLimit)
	}
	if err := validateUpload(p, oversize); err != nil {
		t.Fatalf("a 6.2 MB upload is below the ingest ceiling and must pass transport validation, got %v", err)
	}

	var tooLarge *domain.FileTooLargeError
	err := p.validateStoredSize(oversize.Size)
	if !errors.As(err, &tooLarge) {
		t.Fatalf("a 6.2 MB payload must fail the stored-size check with FileTooLargeError, got %v", err)
	}
	if tooLarge.Limit != storedLimit {
		t.Fatalf("stored refusal limit = %d, want %d", tooLarge.Limit, storedLimit)
	}

	if err := p.validateStoredSize(storedLimit); err != nil {
		t.Fatalf("a payload of exactly %d bytes must be accepted, got %v", storedLimit, err)
	}
}

// Given the 20 MB ingest ceiling, when a payload exceeds it, then the
// transport stage refuses it with that ceiling before any compression runs.
func TestUpload_RejectsOversizeIngest(t *testing.T) {
	cfg := loadTestConfig(t, "5", localAllowlist)
	p := newPolicy(cfg.Upload)
	if p.maxIngestBytes != 20*mebibyte {
		t.Fatalf("Given the default ingest ceiling, parsed limit must be 20 MiB, got %d", p.maxIngestBytes)
	}

	var tooLarge *domain.FileTooLargeError
	err := validateUpload(p, pngRequest(p.maxIngestBytes+1))
	if !errors.As(err, &tooLarge) {
		t.Fatalf("an over-ingest payload must be a FileTooLargeError, got %v", err)
	}
	if tooLarge.Limit != p.maxIngestBytes {
		t.Fatalf("ingest refusal limit = %d, want %d", tooLarge.Limit, p.maxIngestBytes)
	}
}

// Given a valid 5 MB ceiling, when a request declares a non-positive size,
// then it is refused rather than streamed.
func TestUpload_RejectsNonPositiveSize(t *testing.T) {
	cfg := loadTestConfig(t, "5", localAllowlist)
	p := newPolicy(cfg.Upload)

	for _, size := range []int64{0, -1} {
		err := validateUpload(p, pngRequest(size))
		if !errors.Is(err, domain.ErrStorageRejected) {
			t.Fatalf("size %d must satisfy errors.Is(err, domain.ErrStorageRejected), got %v", size, err)
		}
	}
}

// Given the pdf/jpeg/png allowlist from ALLOWED_MIME_TYPES, when a disallowed
// content type is validated, then the upload is refused - including the empty
// type, which is never a pass.
func TestUpload_RejectsDisallowedMIMETypes(t *testing.T) {
	cfg := loadTestConfig(t, "5", localAllowlist)
	p := newPolicy(cfg.Upload)

	cases := []struct {
		name        string
		fileName    string
		contentType string
	}{
		{"windows executable", "installer.exe", "application/vnd.microsoft.portable-executable"},
		{"zip archive", "bundle.zip", "application/zip"},
		{"shell script", "deploy.sh", "application/x-sh"},
		{"legacy word document", "surat-tugas.doc", "application/msword"},
		{
			"docx word document",
			"surat-tugas.docx",
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		},
		{"empty content type", "surat-tugas.pdf", ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := pngRequest(1024)
			in.FileName = tc.fileName
			in.ContentType = tc.contentType
			err := validateUpload(p, in)
			if !errors.Is(err, domain.ErrStorageRejected) {
				t.Fatalf("content type %q must satisfy errors.Is(err, domain.ErrStorageRejected), got %v", tc.contentType, err)
			}
		})
	}
}

// Given the pdf/jpeg/png allowlist, when each allowed content type is
// validated, then none of them is refused.
func TestUpload_AcceptsAllowedMIMETypes(t *testing.T) {
	cfg := loadTestConfig(t, "5", localAllowlist)
	p := newPolicy(cfg.Upload)

	cases := []struct {
		fileName    string
		contentType string
	}{
		{"surat-tugas.pdf", "application/pdf"},
		{"foto-pos.jpg", "image/jpeg"},
		{"foto-pos.png", "image/png"},
	}

	for _, tc := range cases {
		t.Run(tc.contentType, func(t *testing.T) {
			in := pngRequest(1024)
			in.FileName = tc.fileName
			in.ContentType = tc.contentType
			if err := validateUpload(p, in); err != nil {
				t.Fatalf("content type %q must be accepted, got %v", tc.contentType, err)
			}
		})
	}
}

// Given a request whose Content reader is nil, when it is validated, then it
// is refused before any network call is attempted.
func TestUpload_RejectsMissingContent(t *testing.T) {
	cfg := loadTestConfig(t, "5", localAllowlist)
	p := newPolicy(cfg.Upload)

	in := pngRequest(1024)
	in.Content = nil
	if err := validateUpload(p, in); !errors.Is(err, domain.ErrStorageRejected) {
		t.Fatalf("a nil Content must satisfy errors.Is(err, domain.ErrStorageRejected), got %v", err)
	}
}
