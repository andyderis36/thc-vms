package handlers

import (
	"thc-vms/backend/internal/avatarpath"
	"thc-vms/backend/internal/domain"
)

// avatarURL projects one stored avatar value onto the host-agnostic API path
// served by GET /avatars/:id. A blank stored value stays null; the raw
// private-bucket address never reaches the client.
func avatarURL(userID domain.UUID, stored string) *string {
	return avatarpath.URL(userID, stored)
}
