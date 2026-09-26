package auth

import (
	"context"

	"thc-vms/backend/internal/domain"
)

// Me returns the enriched profile for one account id, backing GET /auth/me.
// A missing account surfaces the standard 404 through FromError; no status
// gate applies here because reading one's own profile changes nothing.
func (s *Service) Me(ctx context.Context, userID domain.UUID) (Profile, error) {
	if s.users == nil {
		return Profile{}, domain.FromError(errUnwired)
	}
	user, err := s.users.FindByID(ctx, userID)
	if err != nil {
		return Profile{}, domain.FromError(err)
	}
	return s.profile(ctx, user)
}
