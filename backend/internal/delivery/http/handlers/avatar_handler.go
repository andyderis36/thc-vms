package handlers

import (
	"context"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/response"
	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/avatar"
)

// AvatarService is the read port the avatar endpoint drives. *avatar.Service
// satisfies it structurally through ResolveAvatarStream, so production wires
// the real service and tests wire a hand-written fake; no mocking library is
// involved.
type AvatarService interface {
	ResolveAvatarStream(ctx context.Context, actor avatar.Actor, targetID domain.UUID) (avatar.Stream, error)
}

// Compile-time proof that the production service wires into the handler.
var _ AvatarService = (*avatar.Service)(nil)

// AvatarHandler serves GET /avatars/:id, streaming one account's profile photo
// inline. It only maps HTTP onto the usecase: scope, namespace and content-type
// rules live in ResolveAvatarStream, and raw bucket URLs never reach this
// layer.
type AvatarHandler struct {
	avatars AvatarService
}

// NewAvatarHandler wires the handler to its usecase port.
func NewAvatarHandler(svc AvatarService) *AvatarHandler {
	return &AvatarHandler{avatars: svc}
}

// Avatar serves GET /avatars/:id. Identity is read first, so an
// unauthenticated caller is refused before the path segment is honoured. The
// {id} path segment must be a uuid; every malformed request is a 400 and never
// reaches the usecase. A usecase refusal projects through response.Fail
// (401/404/...). Success streams the bytes inline via http.ServeContent, so
// Range, 304 and Content-Length come from the standard library rather than a
// hand-rolled writer.
func (h *AvatarHandler) Avatar(c *gin.Context) {
	actor, err := avatarActor(c)
	if err != nil {
		response.Fail(c, err)
		return
	}
	targetID, err := domain.ParseUUID(strings.TrimSpace(c.Param("id")))
	if err != nil {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "ID pengguna tidak valid.")
		return
	}
	stream, err := h.avatars.ResolveAvatarStream(c.Request.Context(), actor, targetID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	defer stream.Content.Close()

	c.Header("Content-Type", stream.ContentType)
	c.Header("Content-Disposition", `inline; filename="avatar"`)
	c.Header("Cache-Control", "private, max-age=300")
	c.Header("ETag", stream.ETag)
	c.Header("X-Content-Type-Options", "nosniff")
	http.ServeContent(c.Writer, c.Request, "avatar", stream.ModTime, bodySeeker(stream.Content, stream.Size))
}
