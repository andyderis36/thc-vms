// Package jwt mints and verifies the stateless HS256 bearer tokens the
// middleware consumes (docs/3. Arsitektur Auth). The wire payload carries
// exactly four mandated claims - sub, role, location_id, location_name -
// plus the standard exp/iat pair. It never carries the password hash, the
// email, or the vendor id.
package jwt

import (
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"thc-vms/backend/internal/config"
	"thc-vms/backend/internal/domain"
)

// Claims is the full token payload. LocationID is a pointer with no omitempty
// so a nil location (super_admin, pic) serialises as JSON null, never as "":
// branch scoping downstream compares against null.
type Claims struct {
	jwt.RegisteredClaims
	Role         domain.RoleName `json:"role"`
	LocationID   *domain.UUID    `json:"location_id"`
	LocationName string          `json:"location_name"`
}

// Directory resolves the human names a bare domain.User cannot carry: the
// port gap is that UserRepository returns domain.User (RoleID only, no role
// name, no location name) while the token mandates both. The production
// adapter backs this with two indexed primary-key lookups; tests use a map.
// A nil Directory is tolerated and yields empty names, but production MUST
// wire it: the middleware denies role-less callers, so an unwired service
// only ever mints tokens nobody can use.
type Directory interface {
	LookupRole(id domain.UUID) (domain.RoleName, error)
	LookupLocation(id domain.UUID) (string, error)
}

// Service signs and verifies tokens. The zero value is useless: always build
// with NewService so the secret and TTL come from config, never literals.
type Service struct {
	secret []byte
	ttl    time.Duration
	dir    Directory
}

// NewService builds the signer from config. It never defaults the secret:
// an empty secret fails closed later, at Issue and Parse time.
func NewService(cfg *config.Config) *Service {
	if cfg == nil {
		return &Service{}
	}
	return &Service{secret: []byte(cfg.JWT.Secret), ttl: cfg.JWT.TTL()}
}

// WithDirectory attaches the role/location resolver and returns the service
// for chaining.
func (s *Service) WithDirectory(dir Directory) *Service {
	s.dir = dir
	return s
}

// Issue mints one HS256 token for user. role and location_name resolve
// through the Directory; a nil LocationID becomes JSON null with an empty
// name. A role/location lookup failure fails closed: no role-less token is
// ever minted.
func (s *Service) Issue(user domain.User) (string, error) {
	if len(s.secret) == 0 {
		return "", fmt.Errorf("jwt: refusing to sign with an empty secret: %w", domain.ErrUnauthorized)
	}
	now := time.Now()
	claims := Claims{LocationID: user.LocationID}
	claims.Subject = string(user.ID)
	claims.IssuedAt = jwt.NewNumericDate(now)
	claims.ExpiresAt = jwt.NewNumericDate(now.Add(s.ttl))
	if s.dir != nil {
		role, err := s.dir.LookupRole(user.RoleID)
		if err != nil {
			return "", fmt.Errorf("jwt: resolve role: %w", domain.ErrUnauthorized)
		}
		claims.Role = role
		if user.LocationID != nil {
			name, err := s.dir.LookupLocation(*user.LocationID)
			if err != nil {
				return "", fmt.Errorf("jwt: resolve location: %w", domain.ErrUnauthorized)
			}
			claims.LocationName = name
		}
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := token.SignedString(s.secret)
	if err != nil {
		return "", fmt.Errorf("jwt: sign token: %w", domain.ErrUnauthorized)
	}
	return signed, nil
}

// Parse verifies one token and returns its claims. The key function accepts
// exactly jwt.SigningMethodHS256 and rejects everything else, which is the
// defence against alg:none and algorithm-confusion attacks; the valid-methods
// option repeats the same restriction as depth. Every failure - bad
// signature, expiry, wrong algorithm, malformed input - wraps
// domain.ErrUnauthorized so the envelope renders 401.
func (s *Service) Parse(tokenString string) (Claims, error) {
	var claims Claims
	if len(s.secret) == 0 {
		return Claims{}, fmt.Errorf("jwt: refusing to verify with an empty secret: %w", domain.ErrUnauthorized)
	}
	token, err := jwt.ParseWithClaims(
		tokenString,
		&claims,
		func(token *jwt.Token) (any, error) {
			if token.Method != jwt.SigningMethodHS256 {
				return nil, fmt.Errorf("jwt: unexpected signing method: %w", domain.ErrUnauthorized)
			}
			return s.secret, nil
		},
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
	)
	if err != nil {
		if errors.Is(err, domain.ErrUnauthorized) {
			return Claims{}, err
		}
		return Claims{}, fmt.Errorf("jwt: parse token: %w", domain.ErrUnauthorized)
	}
	if !token.Valid {
		return Claims{}, fmt.Errorf("jwt: invalid token: %w", domain.ErrUnauthorized)
	}
	if claims.Subject == "" {
		return Claims{}, fmt.Errorf("jwt: missing subject: %w", domain.ErrUnauthorized)
	}
	return claims, nil
}
