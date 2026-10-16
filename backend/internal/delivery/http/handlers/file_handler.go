package handlers

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/response"
	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/visit"
)

// FileService is the read port the scoped file endpoint drives. *visit.Service
// satisfies it structurally through ResolveFileStream, so production wires the
// real service and tests wire a hand-written fake; no mocking library is
// involved.
type FileService interface {
	ResolveFileStream(ctx context.Context, actor visit.Actor, visitID domain.UUID, kind visit.FileKind, visitorID domain.UUID) (visit.ObjectStream, error)
}

// Compile-time proof that the production service wires into the handler.
var _ FileService = (*visit.Service)(nil)

// FileHandler serves GET /visits/:id/file, streaming one stored file slot
// (SPK assignment letter, KTP photo or technician selfie) inline. It only maps
// HTTP onto the usecase: branch/vendor scoping, slot selection and the
// fail-closed 404s all live in ResolveFileStream, and raw bucket URLs never
// reach this layer.
type FileHandler struct {
	files FileService
}

// NewFileHandler wires the handler to its usecase port.
func NewFileHandler(svc FileService) *FileHandler {
	return &FileHandler{files: svc}
}

// File serves GET /visits/:id/file?kind=assignment_letter|id_card|selfie&visitor_id=<uuid>.
// Identity is read first, so an unauthenticated caller is refused before any
// query parameter is honoured. The {id} path segment must be a uuid; kind must
// be one of the three slots; id_card and selfie additionally require a uuid
// visitor_id. Every malformed request is a 400 and never reaches the usecase.
// A usecase refusal projects through response.Fail (403/404/...). Success
// streams the bytes inline via http.ServeContent, so Range, 206 and
// Content-Length come from the standard library rather than a hand-rolled
// writer.
func (h *FileHandler) File(c *gin.Context) {
	actor, err := visitActor(c)
	if err != nil {
		response.Fail(c, err)
		return
	}
	visitID, err := domain.ParseUUID(strings.TrimSpace(c.Param("id")))
	if err != nil {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "ID kunjungan tidak valid.")
		return
	}
	kind, ok := parseFileKind(c.Query("kind"))
	if !ok {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Jenis berkas tidak dikenal.")
		return
	}
	// The assignment letter lives on the visit row, so visitor_id is ignored
	// there; the two per-visitor slots require it and it must be a uuid.
	var visitorID domain.UUID
	if kind == visit.FileKindIDCard || kind == visit.FileKindSelfie {
		rawVisitorID := strings.TrimSpace(c.Query("visitor_id"))
		if rawVisitorID == "" {
			response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "visitor_id wajib diisi untuk jenis berkas ini.")
			return
		}
		parsed, err := domain.ParseUUID(rawVisitorID)
		if err != nil {
			response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "visitor_id tidak valid.")
			return
		}
		visitorID = parsed
	}
	stream, err := h.files.ResolveFileStream(c.Request.Context(), actor, visitID, kind, visitorID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	defer stream.Content.Close()

	c.Header("Content-Type", stream.ContentType)
	c.Header("Content-Disposition", contentDisposition(stream.FileName))
	c.Header("Cache-Control", "private, no-store")
	c.Header("Pragma", "no-cache")
	c.Header("X-Content-Type-Options", "nosniff")
	http.ServeContent(c.Writer, c.Request, stream.FileName, stream.ModTime, bodySeeker(stream.Content, stream.Size))
}

// parseFileKind maps the raw kind query value onto the three known slots.
func parseFileKind(raw string) (visit.FileKind, bool) {
	kind := visit.FileKind(strings.TrimSpace(raw))
	switch kind {
	case visit.FileKindAssignmentLetter, visit.FileKindIDCard, visit.FileKindSelfie:
		return kind, true
	default:
		return "", false
	}
}

// contentDisposition builds the inline disposition header. CR/LF and quotes are
// stripped so a stored file name can never split the header.
func contentDisposition(name string) string {
	name = strings.NewReplacer("\r", "", "\n", "", `"`, "").Replace(name)
	if name == "" {
		name = "berkas"
	}
	return `inline; filename="` + name + `"`
}

// bodySeeker adapts the resolved object body for http.ServeContent, which needs
// an io.ReadSeeker to answer Range requests and to set Content-Length. A
// natively seekable body (the MinIO object in production) is served as-is with
// zero buffering; a non-seekable body is wrapped in a forward-only seeker that
// still streams straight from storage without buffering the payload.
func bodySeeker(content io.ReadCloser, size int64) io.ReadSeeker {
	if seeker, ok := content.(io.ReadSeeker); ok {
		return seeker
	}
	return &forwardSeeker{body: content, size: size}
}

// forwardSeeker gives http.ServeContent the forward-only seeking it performs;
// it never buffers the body. ServeContent probes the size with
// Seek(0, SeekEnd) and immediately rewinds with Seek(0, SeekStart), so SeekEnd
// answers from the known size without draining the one-shot stream, and a range
// offset is reached by discarding the bytes before it. A backward seek is
// refused because the body streams once from storage.
type forwardSeeker struct {
	body io.Reader
	size int64
	pos  int64
}

func (s *forwardSeeker) Read(p []byte) (int, error) {
	n, err := s.body.Read(p)
	s.pos += int64(n)
	return n, err
}

func (s *forwardSeeker) Seek(offset int64, whence int) (int64, error) {
	if whence == io.SeekEnd {
		return s.size + offset, nil
	}
	var target int64
	switch whence {
	case io.SeekStart:
		target = offset
	case io.SeekCurrent:
		target = s.pos + offset
	default:
		return 0, fmt.Errorf("handlers: invalid seek whence %d", whence)
	}
	if target < 0 {
		return 0, errors.New("handlers: seek before start of stream")
	}
	if target < s.pos {
		return 0, errors.New("handlers: backward seek on a one-shot stream")
	}
	if target > s.pos {
		if _, err := io.CopyN(io.Discard, s.body, target-s.pos); err != nil {
			return s.pos, err
		}
		s.pos = target
	}
	return s.pos, nil
}
