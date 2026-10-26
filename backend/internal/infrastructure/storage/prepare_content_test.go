package storage

import (
	"bytes"
	"errors"
	"image"
	"image/jpeg"
	"image/png"
	"testing"

	"thc-vms/backend/internal/domain"
)

// prepareTestPolicy loads the documented defaults so the test exercises the
// same 5 MB stored / 20 MB ingest split production runs with.
func prepareTestPolicy(t *testing.T) policy {
	t.Helper()
	t.Setenv("MAX_UPLOAD_INGEST_MB", "20")
	return newPolicy(loadTestConfig(t, "5", localAllowlist).Upload)
}

// noisyImage fills a deterministic pseudo-random raster so the encoder cannot
// shrink it away: the fixture must exceed imagecompress.SkipBelowBytes for the
// re-encode path to run at all.
func noisyImage(width, height int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	seed := uint32(0x9e3779b9)
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			seed = seed*1664525 + 1013904223
			offset := img.PixOffset(x, y)
			img.Pix[offset] = byte(seed)
			img.Pix[offset+1] = byte(seed >> 8)
			img.Pix[offset+2] = byte(seed >> 16)
			img.Pix[offset+3] = 0xff
		}
	}
	return img
}

// Given a 3200x2000 JPEG encoded at quality 95, when it is prepared, then the
// stored bytes are re-encoded as a smaller image with its longest side capped
// at 1600 px and still typed image/jpeg.
func TestPrepareStoredContent_DownscalesJPEG(t *testing.T) {
	p := prepareTestPolicy(t)
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, noisyImage(3200, 2000), &jpeg.Options{Quality: 95}); err != nil {
		t.Fatalf("encode JPEG fixture: %v", err)
	}

	content, mimeType, err := prepareStoredContent(domain.UploadRequest{
		ContentType: "image/jpeg",
		Content:     bytes.NewReader(encoded.Bytes()),
	}, p)
	if err != nil {
		t.Fatalf("prepare must accept a legal JPEG, got %v", err)
	}
	if mimeType != "image/jpeg" {
		t.Fatalf("prepared MIME = %q, want image/jpeg", mimeType)
	}
	if len(content) >= encoded.Len() {
		t.Fatalf("prepared JPEG must be smaller than the %d-byte input, got %d", encoded.Len(), len(content))
	}
	assertLongestSide(t, content, 1600)
}

// Given a 2000x1200 PNG, when it is prepared, then it stays image/png and its
// longest side is capped at 1600 px.
func TestPrepareStoredContent_DownscalesPNGKeepingType(t *testing.T) {
	p := prepareTestPolicy(t)
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, noisyImage(2000, 1200)); err != nil {
		t.Fatalf("encode PNG fixture: %v", err)
	}

	content, mimeType, err := prepareStoredContent(domain.UploadRequest{
		ContentType: "image/png",
		Content:     bytes.NewReader(encoded.Bytes()),
	}, p)
	if err != nil {
		t.Fatalf("prepare must accept a legal PNG, got %v", err)
	}
	if mimeType != "image/png" {
		t.Fatalf("prepared MIME = %q, want image/png", mimeType)
	}
	assertLongestSide(t, content, 1600)
}

// Given a payload one byte past the ingest ceiling, when it is prepared, then
// it is refused with the transport limit, not the stored one.
func TestPrepareStoredContent_RejectsOversizeIngest(t *testing.T) {
	p := prepareTestPolicy(t)
	payload := make([]byte, p.maxIngestBytes+1)

	content, _, err := prepareStoredContent(domain.UploadRequest{
		ContentType: "image/png",
		Content:     bytes.NewReader(payload),
	}, p)

	var tooLarge *domain.FileTooLargeError
	if !errors.As(err, &tooLarge) {
		t.Fatalf("oversize ingest must be a FileTooLargeError, got %v", err)
	}
	if tooLarge.Limit != p.maxIngestBytes {
		t.Fatalf("ingest refusal limit = %d, want %d", tooLarge.Limit, p.maxIngestBytes)
	}
	if content != nil {
		t.Fatalf("a refused upload must return no content, got %d bytes", len(content))
	}
}

// Given an empty payload, when it is prepared, then it is refused as a storage
// rejection rather than a size breach.
func TestPrepareStoredContent_RejectsEmptyPayload(t *testing.T) {
	p := prepareTestPolicy(t)

	content, _, err := prepareStoredContent(domain.UploadRequest{
		ContentType: "image/png",
		Content:     bytes.NewReader(nil),
	}, p)
	if !errors.Is(err, domain.ErrStorageRejected) {
		t.Fatalf("empty payload must satisfy errors.Is(err, domain.ErrStorageRejected), got %v", err)
	}
	if content != nil {
		t.Fatalf("an empty payload must return no content, got %d bytes", len(content))
	}
}

// Given a 6 MB unreadable PDF, when preparation cannot optimise it, then the
// upload is refused with the stored limit and no original bytes are returned,
// because the over-limit original must never be persisted as a fallback.
func TestPrepareStoredContent_RefusesUnoptimisableOversizePDF(t *testing.T) {
	p := prepareTestPolicy(t)
	payload := make([]byte, 6*mebibyte)
	copy(payload, "%PDF-1.4\n")

	content, _, err := prepareStoredContent(domain.UploadRequest{
		ContentType: "application/pdf",
		Content:     bytes.NewReader(payload),
	}, p)

	var tooLarge *domain.FileTooLargeError
	if !errors.As(err, &tooLarge) {
		t.Fatalf("an unoptimisable oversize PDF must be a FileTooLargeError, got %v", err)
	}
	if tooLarge.Limit != p.maxSizeBytes {
		t.Fatalf("PDF refusal limit = %d, want %d", tooLarge.Limit, p.maxSizeBytes)
	}
	if tooLarge.Cause == nil {
		t.Fatal("a failed PDF optimisation must keep the compression cause")
	}
	if content != nil {
		t.Fatalf("the over-limit original must not be returned, got %d bytes", len(content))
	}
}

// Given a 1 MB PDF under the stored ceiling, when it is prepared, then it is
// returned byte-identical because no optimisation is warranted.
func TestPrepareStoredContent_KeepsSmallPDFUntouched(t *testing.T) {
	p := prepareTestPolicy(t)
	payload := make([]byte, 1*mebibyte)
	copy(payload, "%PDF-1.4\n")
	for i := 9; i < len(payload); i++ {
		payload[i] = byte(i * 31)
	}

	content, mimeType, err := prepareStoredContent(domain.UploadRequest{
		ContentType: "application/pdf",
		Content:     bytes.NewReader(payload),
	}, p)
	if err != nil {
		t.Fatalf("a small PDF must pass through, got %v", err)
	}
	if mimeType != "application/pdf" {
		t.Fatalf("prepared MIME = %q, want application/pdf", mimeType)
	}
	if !bytes.Equal(content, payload) {
		t.Fatal("a small PDF must be stored byte-identical to the upload")
	}
}

// assertLongestSide decodes just the config to prove the re-encoded raster is
// bounded without materialising the full image again.
func assertLongestSide(t *testing.T, content []byte, limit int) {
	t.Helper()
	cfg, _, err := image.DecodeConfig(bytes.NewReader(content))
	if err != nil {
		t.Fatalf("decode prepared image config: %v", err)
	}
	if longest := max(cfg.Width, cfg.Height); longest > limit {
		t.Fatalf("prepared longest side = %d px, want <= %d", longest, limit)
	}
}
