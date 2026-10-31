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
// stamp last login, project the profile. Unknown emails, wrong passwords and
// blacklisted accounts return the byte-identical 401 so the response never
// reveals whether an account exists; a repository ErrNotFound becomes that
// 401, never a 404. Inactive accounts (self-registered vendors waiting for
// superadmin approval) fail closed with a 403 naming the wait instead.
//
// Every outcome feeds the audit trail best-effort (auth.login.success /
// auth.login.failed): the metadata carries ONLY the normalised email, never
// the password or its hash, and a trail failure never fails the login itself.
// The failed event uses one reason for unknown-email, wrong-password and
// inactive accounts alike, so the trail cannot become an account oracle.
func (s *Service) Login(ctx context.Context, email, password string) (LoginResult, error) {
	if s.users == nil || s.issuer == nil {
		return LoginResult{}, domain.FromError(errUnwired)
	}
	normalised := strings.ToLower(strings.TrimSpace(email))
	user, err := s.users.FindByEmail(ctx, normalised)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			bcrypt.CompareHashAndPassword(dummyPasswordHash(), []byte(password))
			s.recordLoginFailed(ctx, normalised)
			return LoginResult{}, domain.InvalidCredentials()
		}
		return LoginResult{}, domain.FromError(err)
	}
	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)); err != nil {
		s.recordLoginFailed(ctx, normalised)
		return LoginResult{}, domain.InvalidCredentials()
	}
	if user.Status == domain.UserStatusInactive {
		s.recordLoginFailed(ctx, normalised)
		return LoginResult{}, domain.AccountPending()
	}
	if user.Status != domain.UserStatusActive {
		s.recordLoginFailed(ctx, normalised)
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
	s.recordLoginSuccess(ctx, user.ID, normalised)
	return LoginResult{Token: token, User: userProfile}, nil
}

// loginMeta renders the request provenance stored by the delivery layer (IP
// and User-Agent) for one audit entry: empty when the caller runs without an
// HTTP request (background, hermetic tests).
func loginMeta(ctx context.Context) (ip, userAgent string) {
	if meta, ok := domain.RequestMetaFromContext(ctx); ok {
		return meta.IP, meta.UserAgent
	}
	return "", ""
}

// recordLoginSuccess appends one auth.login.success row best-effort: actor and
// subject are both the authenticated account, and the metadata names only the
// email that was typed.
func (s *Service) recordLoginSuccess(ctx context.Context, userID domain.UUID, email string) {
	if s.audit == nil {
		return
	}
	ip, userAgent := loginMeta(ctx)
	if _, err := s.audit.Append(ctx, domain.AuditEntry{
		ActorID:   &userID,
		Action:    domain.AuditActionLoginSuccess,
		Entity:    domain.AuditEntityUser,
		EntityID:  &userID,
		IP:        ip,
		UserAgent: userAgent,
		Metadata:  map[string]string{"email": email},
	}); err != nil {
		slog.Warn("auth: audit login success failed", "user_id", string(userID), "error", err)
	}
}

// recordLoginFailed appends one auth.login.failed row best-effort: no actor
// (the account may not exist), no subject, and metadata holding ONLY the
// normalised email. The password, its hash and any token never enter.
func (s *Service) recordLoginFailed(ctx context.Context, email string) {
	if s.audit == nil {
		return
	}
	ip, userAgent := loginMeta(ctx)
	if _, err := s.audit.Append(ctx, domain.AuditEntry{
		Action:    domain.AuditActionLoginFailed,
		Entity:    domain.AuditEntityUser,
		IP:        ip,
		UserAgent: userAgent,
		Metadata:  map[string]string{"email": email, "reason": "invalid_credentials"},
	}); err != nil {
		slog.Warn("auth: audit login failed event failed", "error", err)
	}
}
