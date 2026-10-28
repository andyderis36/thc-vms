// Package avatarpath builds the host-agnostic API path every avatar read is
// served from. Stored avatar values are absolute URLs of our private bucket;
// they bind the internal storage host and must never reach the client, so the
// read path projects them onto GET /api/v1/avatars/{id} instead. The version
// query is derived from the stored value, so re-uploading a photo yields a new
// URL and a stale cached image cannot survive the change.
package avatarpath

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"

	"thc-vms/backend/internal/domain"
)

// URL projects one stored avatar value onto the authenticated API path. A
// blank stored value means the account has no photo and yields nil (JSON null).
// The version is the first 8 hex characters of sha256(stored), which changes
// whenever the stored object changes without exposing anything about it.
func URL(userID domain.UUID, stored string) *string {
	trimmed := strings.TrimSpace(stored)
	if trimmed == "" {
		return nil
	}
	sum := sha256.Sum256([]byte(trimmed))
	version := hex.EncodeToString(sum[:])[:8]
	path := fmt.Sprintf("/api/v1/avatars/%s?v=%s", userID, version)
	return &path
}
