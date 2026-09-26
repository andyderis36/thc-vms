package auth

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"

	"golang.org/x/crypto/bcrypt"

	"thc-vms/backend/internal/domain"
)

// dummyPasswordHash is the bcrypt reference compared when the email matches
// no account, so unknown-email and wrong-password logins cost comparable time
// and stay indistinguishable to probers. It is generated once, lazily, at the
// production cost level for timing parity with real hashes.
var dummyPasswordHash = sync.OnceValue(func() []byte {
	hash, err := bcrypt.GenerateFromPassword([]byte("thc-auth-dummy-reference"), bcrypt.DefaultCost)
	if err != nil {
		return nil
	}
	return hash
})

// Login authenticates one account by email+password and mints its bearer
// token: normalise email, FindByEmail, bcrypt compare, status gate, issue,
// stamp last login, project the profile. Unknown emails and wrong passwords
// return the byte-identical 401 so the response never reveals whether an
// account exists; a repository ErrNotFound becomes that 401, never a 404.
func (s *Service) Login(ctx context.Context, email, password string) (LoginResult, error) {
	if s.users == nil || s.issuer == nil {
		return LoginResult{}, domain.FromError(errUnwired)
	}
	normalised := strings.ToLower(strings.TrimSpace(email))
	user, err := s.users.FindByEmail(ctx, normalised)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			bcrypt.CompareHashAndPassword(dummyPasswordHash(), []byte(password))
			return LoginResult{}, domain.InvalidCredentials()
		}
		return LoginResult{}, domain.FromError(err)
	}
	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)); err != nil {
		return LoginResult{}, domain.InvalidCredentials()
	}
	if user.Status != domain.UserStatusActive {
		return LoginResult{}, domain.InvalidCredentials()
	}
	token, err := s.issuer.Issue(user)
	if err != nil {
		return LoginResult{}, domain.FromError(err)
	}
	if err := s.users.UpdateLastLogin(ctx, user.ID, s.clock.Now()); err != nil {
		slog.Warn("auth: update last login failed", "user_id", string(user.ID), "error", err)
	}
	userProfile, err := s.profile(ctx, user)
	if err != nil {
		return LoginResult{}, err
	}
	return LoginResult{Token: token, User: userProfile}, nil
}
