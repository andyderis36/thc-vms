package auth

import "context"

// Logout ends the client session. It is intentionally a no-op: the
// architecture is stateless by mandate (PRD L196 - no server session, no
// token denylist), so the server holds nothing to invalidate and the client
// logs out by discarding its token. No Redis denylist, no in-memory
// blocklist, no jti table is added here; those would reintroduce the server
// state the stateless design removed.
func (s *Service) Logout(_ context.Context) error {
	return nil
}
