package handlers

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/drain"
	"thc-vms/backend/internal/delivery/http/response"
	"thc-vms/backend/internal/domain"
)

// defaultMaxIngestBytes is the transport/ingest ceiling applied when the
// constructor is given no explicit limit. It mirrors the MAX_UPLOAD_INGEST_MB
// default: the raw upload may be up to 20 MB because the storage adapter
// compresses the file and only then applies the 5 MB stored ceiling.
const defaultMaxIngestBytes = 20 * 1024 * 1024

// multipartMemory bounds the RAM ParseMultipartForm may use before it spills
// parts to temp files: 8 MiB when the ingest ceiling allows it, never more than
// the ceiling, and never below 1 MiB. The floor matters because Go treats a
// non-positive maxMemory as 32 MiB.
const (
	multipartMemoryPreferred = 8 * 1024 * 1024
	multipartMemoryMin       = 1 * 1024 * 1024
)

// allowedUploadMIME is the handler-side MIME allow-list mirroring the storage
// policy (application/pdf, image/jpeg, image/png). The adapter re-checks it;
// this pre-check turns a bad upload into a 400 before any storage call.
var allowedUploadMIME = map[string]struct{}{
	"application/pdf": {},
	"image/jpeg":      {},
	"image/png":       {},
}

// imageUploadMIME is the image-only subset a photo category may use.
var imageUploadMIME = map[string]struct{}{
	"image/jpeg": {},
	"image/png":  {},
}

// imageOnlyCategories are the upload categories whose payload is a photo by
// definition, so the shared allow-list's PDF entry is never valid for them.
var imageOnlyCategories = map[string]struct{}{
	"profile_photo": {},
	"work_photos":   {},
}

// UploadHandler serves POST /uploads. It owns the HTTP framing only: the
// size/MIME policy verdict and the object-key layout stay in the storage
// adapter, which the handler reaches through domain.IStorageService.
type UploadHandler struct {
	storage        domain.IStorageService
	maxIngestBytes int64
}

// NewUploadHandler wires the handler to the storage port with an explicit
// transport/ingest byte ceiling; a non-positive limit falls back to
// defaultMaxIngestBytes. The stored 5 MB ceiling is enforced by the storage
// adapter after compression, not here. The explicit limit exists so tests can
// prove the 413 path with a tiny body.
func NewUploadHandler(storage domain.IStorageService, maxIngestBytes int64) *UploadHandler {
	if maxIngestBytes <= 0 {
		maxIngestBytes = defaultMaxIngestBytes
	}
	return &UploadHandler{storage: storage, maxIngestBytes: maxIngestBytes}
}

// multipartMemory returns the ParseMultipartForm memory budget for an ingest
// ceiling of limit: multipartMemoryPreferred bytes, capped at limit, never
// below multipartMemoryMin.
func multipartMemory(limit int64) int64 {
	switch {
	case limit < multipartMemoryMin:
		return multipartMemoryMin
	case limit < multipartMemoryPreferred:
		return limit
	default:
		return multipartMemoryPreferred
	}
}

// Upload serves POST /uploads (multipart/form-data with a file part and a
// category part; owner_id is accepted for backward compatibility).
//
// Owner segment: the storage owner path segment is derived SERVER-SIDE from the
// authenticated actor, never from the client. A client-supplied owner_id is
// accepted but its value is IGNORED, so an authenticated caller can never point
// the object key at another branch's visit namespace. The segment is the single
// path segment "pending-<actorUserID>"; when the actor cannot be resolved it
// degrades to the bare literal "pending". The handler joins it into a
// "category/ownerSegment" HINT; the adapter re-expands the hint into the
// mandated assignment_letters/{id}/... layout itself.
//
// The ingest ceiling (default 20 MB, MAX_UPLOAD_INGEST_MB) is enforced with
// http.MaxBytesReader BEFORE reading the body, so an oversized upload is
// refused with 413 without ever being buffered in RAM; multipart parts spill to
// temp files above multipartMemory and are removed when the request ends. The
// unread remainder is drained before the 413 so net/http does not reset the
// connection and strip the status from the client (I-05). A disallowed MIME
// type is a 400. Success is 201 with
// {file_url, file_name, file_size, mime_type}.
func (h *UploadHandler) Upload(c *gin.Context) {
	originalBody := c.Request.Body
	c.Request.Body = http.MaxBytesReader(c.Writer, originalBody, h.maxIngestBytes)
	if err := c.Request.ParseMultipartForm(multipartMemory(h.maxIngestBytes)); err != nil {
		if strings.Contains(err.Error(), "too large") {
			drain.Bounded(originalBody, h.maxIngestBytes)
			response.FailWith(c, http.StatusRequestEntityTooLarge, "FILE_TOO_LARGE",
				fmt.Sprintf("Ukuran berkas melebihi batas %d byte.", h.maxIngestBytes))
			return
		}
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Isi multipart tidak valid.")
		return
	}
	form := c.Request.MultipartForm
	if form != nil {
		defer func() { _ = form.RemoveAll() }()
	}
	category := strings.TrimSpace(firstFormValue(form.Value, "category"))
	switch category {
	case "assignment_letter", "id_card", "checkin_photo", "profile_photo", "work_photos":
	default:
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Kategori berkas tidak dikenal.")
		return
	}
	// owner_id is accepted but never read: the storage owner segment is derived
	// from the authenticated actor so a caller cannot choose its own namespace.
	ownerSegment := uploadOwnerSegment(c)
	files := form.File["file"]
	if len(files) == 0 {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Berkas wajib diunggah.")
		return
	}
	header := files[0]
	if header.Size > h.maxIngestBytes {
		drain.Bounded(originalBody, h.maxIngestBytes)
		response.FailWith(c, http.StatusRequestEntityTooLarge, "FILE_TOO_LARGE",
			fmt.Sprintf("Ukuran berkas melebihi batas %d byte.", h.maxIngestBytes))
		return
	}
	if header.Size <= 0 {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Ukuran berkas tidak valid.")
		return
	}
	mime := normaliseMIME(header.Header.Get("Content-Type"))
	if _, ok := allowedUploadMIME[mime]; !ok {
		response.Fail(c, fmt.Errorf("tipe MIME berkas tidak diizinkan: %q: %w", mime, domain.ErrStorageRejected))
		return
	}
	if _, imageOnly := imageOnlyCategories[category]; imageOnly {
		// The profile photo is rendered in the shell chrome and the work
		// photos are visual evidence, so both are images by definition; the
		// shared allow-list also admits PDF for the visit documents, which is
		// never a valid photo.
		if _, ok := imageUploadMIME[mime]; !ok {
			response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Berkas foto harus berupa gambar JPG atau PNG.")
			return
		}
	}
	src, err := header.Open()
	if err != nil {
		response.Fail(c, err)
		return
	}
	result, uploadErr := h.storage.Upload(c.Request.Context(), domain.UploadRequest{
		ObjectKey:   category + "/" + ownerSegment,
		FileName:    header.Filename,
		ContentType: mime,
		Size:        header.Size,
		Content:     src,
	})
	closeErr := src.Close()
	if uploadErr != nil {
		response.Fail(c, uploadErr)
		return
	}
	if closeErr != nil {
		response.Fail(c, closeErr)
		return
	}
	response.Created(c, toUploadDTO(result))
}

// uploadOwnerSegment derives the storage owner path segment from the
// authenticated actor. The server owns this segment, so it is always a single
// path segment: "pending-<actorUserID>", or the bare literal "pending" when the
// actor cannot be resolved. A client-supplied owner_id never influences it.
func uploadOwnerSegment(c *gin.Context) string {
	identity, err := identityFromContext(c)
	if err != nil {
		return "pending"
	}
	return "pending-" + string(identity.id)
}

// firstFormValue returns the first value for a multipart field, if any.
func firstFormValue(values map[string][]string, key string) string {
	if got, ok := values[key]; ok && len(got) > 0 {
		return got[0]
	}
	return ""
}

// normaliseMIME lowercases the media type and drops RFC 2045 parameters.
func normaliseMIME(contentType string) string {
	base, _, _ := strings.Cut(contentType, ";")
	return strings.ToLower(strings.TrimSpace(base))
}
