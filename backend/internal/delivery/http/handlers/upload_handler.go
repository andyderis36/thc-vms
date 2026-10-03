package handlers

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/response"
	"thc-vms/backend/internal/domain"
)

// defaultMaxUploadBytes is the 5 MB ceiling from AGENTS.md 6.4, applied when
// the constructor is given no explicit limit.
const defaultMaxUploadBytes = 5 * 1024 * 1024

// allowedUploadMIME is the handler-side MIME allow-list mirroring the storage
// policy (application/pdf, image/jpeg, image/png). The adapter re-checks it;
// this pre-check turns a bad upload into a 400 before any storage call.
var allowedUploadMIME = map[string]struct{}{
	"application/pdf": {},
	"image/jpeg":      {},
	"image/png":       {},
}

// UploadHandler serves POST /uploads. It owns the HTTP framing only: the
// size/MIME policy verdict and the object-key layout stay in the storage
// adapter, which the handler reaches through domain.IStorageService.
type UploadHandler struct {
	storage  domain.IStorageService
	maxBytes int64
}

// NewUploadHandler wires the handler to the storage port with an explicit
// byte ceiling; a non-positive limit falls back to the 5 MB default. The
// explicit limit exists so tests can prove the 413 path with a tiny body.
func NewUploadHandler(storage domain.IStorageService, maxBytes int64) *UploadHandler {
	if maxBytes <= 0 {
		maxBytes = defaultMaxUploadBytes
	}
	return &UploadHandler{storage: storage, maxBytes: maxBytes}
}

// Upload serves POST /uploads (multipart/form-data with a file part and a
// category part; owner_id is optional).
//
// Owner-id choice: assignment_letter and checkin_photo are visit-scoped while
// id_card is visitor-scoped, so the caller passes the owning visit id (uuid
// or VST- code) or visitor id as the optional owner_id form field. The
// pre-create flow (/visits/new) has no visit id yet, so an empty owner_id
// stages under "pending" (assignment_letters/pending/...). The handler joins
// it into a "category/ownerID" HINT; the adapter re-expands the hint into
// the mandated assignment_letters/{id}/... layout itself.
//
// The 5 MB ceiling is enforced with http.MaxBytesReader BEFORE reading the
// body, so an oversized upload is refused with 413 without ever being
// buffered; a disallowed MIME type is a 400. Success is 201 with
// {file_url, file_name, file_size, mime_type}.
func (h *UploadHandler) Upload(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, h.maxBytes)
	if err := c.Request.ParseMultipartForm(h.maxBytes); err != nil {
		if strings.Contains(err.Error(), "too large") {
			response.FailWith(c, http.StatusRequestEntityTooLarge, "FILE_TOO_LARGE",
				fmt.Sprintf("Ukuran berkas melebihi batas %d byte.", h.maxBytes))
			return
		}
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Isi multipart tidak valid.")
		return
	}
	form := c.Request.MultipartForm
	category := strings.TrimSpace(firstFormValue(form.Value, "category"))
	switch category {
	case "assignment_letter", "id_card", "checkin_photo":
	default:
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Kategori berkas tidak dikenal.")
		return
	}
	ownerID := strings.TrimSpace(firstFormValue(form.Value, "owner_id"))
	if ownerID == "" {
		ownerID = "pending"
	}
	if !validOwnerID(ownerID) {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "ID pemilik berkas tidak valid.")
		return
	}
	files := form.File["file"]
	if len(files) == 0 {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Berkas wajib diunggah.")
		return
	}
	header := files[0]
	if header.Size > h.maxBytes {
		response.FailWith(c, http.StatusRequestEntityTooLarge, "FILE_TOO_LARGE",
			fmt.Sprintf("Ukuran berkas melebihi batas %d byte.", h.maxBytes))
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
	src, err := header.Open()
	if err != nil {
		response.Fail(c, err)
		return
	}
	result, uploadErr := h.storage.Upload(c.Request.Context(), domain.UploadRequest{
		ObjectKey:   category + "/" + ownerID,
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

// firstFormValue returns the first value for a multipart field, if any.
func firstFormValue(values map[string][]string, key string) string {
	if got, ok := values[key]; ok && len(got) > 0 {
		return got[0]
	}
	return ""
}

// validOwnerID accepts the identifier shape the storage adapter accepts for
// its hint segment: a uuid, or a VST- business code. Letters, digits, dash,
// underscore and dot pass; anything else (separator, space, traversal) fails
// so the hint can never smuggle a path segment.
func validOwnerID(ownerID string) bool {
	if ownerID == "" || len(ownerID) > 64 {
		return false
	}
	if ownerID == ".." || strings.Contains(ownerID, "..") || strings.Contains(ownerID, "/") {
		return false
	}
	for _, r := range ownerID {
		switch {
		case r >= 'a' && r <= 'z',
			r >= 'A' && r <= 'Z',
			r >= '0' && r <= '9',
			r == '-', r == '_', r == '.':
		default:
			return false
		}
	}
	return true
}

// normaliseMIME lowercases the media type and drops RFC 2045 parameters.
func normaliseMIME(contentType string) string {
	base, _, _ := strings.Cut(contentType, ";")
	return strings.ToLower(strings.TrimSpace(base))
}
