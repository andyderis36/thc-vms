package middleware

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/drain"
	"thc-vms/backend/internal/delivery/http/response"
	"thc-vms/backend/internal/validation"
)

// bodyBearingMethods are the methods whose bodies are capped. GET/DELETE carry
// no JSON body in this API, and OPTIONS is answered by CORS before this runs.
var bodyBearingMethods = map[string]struct{}{
	http.MethodPost:  {},
	http.MethodPut:   {},
	http.MethodPatch: {},
}

// maxDrainBytes bounds how much of a rejected body is read before the 413, so a
// client that is still writing finishes and reads the status instead of getting
// a reset. 32 MiB covers the largest ingest the API accepts; anything bigger is
// abusive and may lose the response.
const maxDrainBytes int64 = 32 << 20

// BodyLimit caps a request body at maxBytes and answers 413 with the standard
// failure envelope when the body is larger. Only the route at
// multipartExemptPath may stream a multipart body past the cap: that handler
// enforces the larger ingest ceiling itself. Every other request is capped
// regardless of the Content-Type it declares, because ShouldBindJSON ignores
// Content-Type - a JSON body labelled multipart would otherwise skip the limit
// entirely.
//
// A declared Content-Length above maxBytes is rejected before the body is read,
// so an Expect: 100-continue client receives the 413 without uploading at all.
// Otherwise the body is read once through http.MaxBytesReader and replayed to
// the handler, so the verdict is deterministic for chunked requests with no
// Content-Length. Before the 413 the unread remainder is drained, otherwise
// net/http closes the connection with RST and the client can lose the
// already-written status (I-05). A non-positive limit falls back to the
// canonical JSON ceiling.
func BodyLimit(maxBytes int64, multipartExemptPath string) gin.HandlerFunc {
	if maxBytes <= 0 {
		maxBytes = validation.JSONBodyMaxBytes
	}
	return func(c *gin.Context) {
		if !bodyBearing(c.Request.Method) || c.Request.Body == nil {
			c.Next()
			return
		}
		if isMultipart(c.GetHeader("Content-Type")) && c.FullPath() == multipartExemptPath {
			c.Next()
			return
		}
		originalBody := c.Request.Body
		if c.Request.ContentLength > maxBytes {
			if !strings.EqualFold(strings.TrimSpace(c.GetHeader("Expect")), "100-continue") {
				drain.Bounded(originalBody, maxDrainBytes)
			}
			failTooLarge(c, maxBytes)
			return
		}
		limited := http.MaxBytesReader(c.Writer, originalBody, maxBytes)
		body, err := io.ReadAll(limited)
		if err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				drain.Bounded(originalBody, maxDrainBytes)
				failTooLarge(c, maxBytes)
			} else {
				response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Body permintaan tidak dapat dibaca.")
				c.Abort()
			}
			return
		}
		c.Request.Body = io.NopCloser(bytes.NewReader(body))
		c.Next()
	}
}

func failTooLarge(c *gin.Context, maxBytes int64) {
	response.FailWith(c, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE",
		fmt.Sprintf("Ukuran body permintaan melebihi batas %d byte.", maxBytes))
	c.Abort()
}

// bodyBearing reports whether method is allowed to carry a JSON body.
func bodyBearing(method string) bool {
	_, ok := bodyBearingMethods[method]
	return ok
}

// isMultipart reports whether the request declares a multipart payload.
func isMultipart(contentType string) bool {
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		return false
	}
	return strings.HasPrefix(mediaType, "multipart/")
}
