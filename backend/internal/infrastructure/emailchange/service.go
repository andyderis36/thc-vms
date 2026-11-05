// Package emailchange mints and verifies the stateless HS256 tokens that
// confirm an email-address change. The wire payload carries exactly the
// frozen claim set - purpose=email-change, iss/aud=thc-vms, user_id,
// old_email, new_email - plus the standard exp/iat pair. It never carries
// the password hash or any other profile field.
//
// The token is a bearer proof that the holder controls the new address; it
// is NOT single-use by itself. Single-use is enforced downstream by the
// caller binding old_email against the current row at confirm time, so a
// replayed token finds a mismatched old_email and fails. Every failure here
// surfaces as an error wrapping domain.ErrUnauthorized for the caller to map
// to the generic confirm message.
package emailchange

import (
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"thc-vms/backend/internal/domain"
)

// Frozen token constants. These strings are part of the confirm contract:
// parallel tasks (usecase T4) mint and verify against them, so changing any
// value breaks confirm without a compile error. Do not edit.
const (
	// Purpose is the single accepted purpose claim value.
	Purpose = "email-change"
	// Issuer is the iss claim minted and the only one accepted.
	Issuer = "thc-vms"
	// Audience is the aud claim minted and the only one accepted.
	Audience = "thc-vms"
	// TTL bounds how long a confirm link stays valid after minting.
	TTL = 60 * time.Minute
)

// Claims is the full token payload. The custom purpose/user_id/old_email/
// new_email fields ride alongside the registered iss/aud/exp/iat pair; the
// strict Verify checks pin purpose, issuer and audience to the frozen
// constants above.
type Claims struct {
	jwt.RegisteredClaims
	Purpose  string      `json:"purpose"`
	UserID   domain.UUID `json:"user_id"`
	OldEmail string      `json:"old_email"`
	NewEmail string      `json:"new_email"`
}

// Service signs and verifies email-change tokens. The zero value is useless:
// always build with NewService so the secret comes from config (the existing
// JWT secret, no new key material), never literals.
type Service struct {
	secret []byte
}

// NewService builds the signer from the existing JWT secret. It never
// defaults the secret: an empty secret fails closed later, at Mint and
// Verify time.
func NewService(secret string) *Service {
	return &Service{secret: []byte(secret)}
}

// Mint issues one HS256 token binding userID to the oldEmail -> newEmail
// move. Blank identifiers fail closed: a token without a subject or with an
// empty endpoint cannot confirm anything, so none is minted.
func (s *Service) Mint(userID domain.UUID, oldEmail, newEmail string) (string, error) {
	if len(s.secret) == 0 {
		return "", fmt.Errorf("emailchange: refusing to sign with an empty secret: %w", domain.ErrUnauthorized)
	}
	if userID == "" || oldEmail == "" || newEmail == "" {
		return "", fmt.Errorf("emailchange: refusing to mint a token with a blank identity: %w", domain.ErrUnauthorized)
	}
	now := time.Now()
	claims := Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    Issuer,
			Audience:  jwt.ClaimStrings{Audience},
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(TTL)),
		},
		Purpose:  Purpose,
		UserID:   userID,
		OldEmail: oldEmail,
		NewEmail: newEmail,
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := token.SignedString(s.secret)
	if err != nil {
		return "", fmt.Errorf("emailchange: sign token: %w", domain.ErrUnauthorized)
	}
	return signed, nil
}

// Verify checks one token and returns its claims. The key function accepts
// exactly jwt.SigningMethodHS256 and rejects everything else, which is the
// defence against alg:none and algorithm-confusion attacks; the valid-methods
// option repeats the same restriction as depth. Past the library checks,
// purpose, issuer and audience must equal the frozen constants and the
// identity fields must be non-empty. Every failure - bad signature, expiry,
// wrong purpose/issuer/audience, malformed input - wraps
// domain.ErrUnauthorized so the caller renders the generic confirm message.
func (s *Service) Verify(tokenString string) (Claims, error) {
	var claims Claims
	if len(s.secret) == 0 {
		return Claims{}, fmt.Errorf("emailchange: refusing to verify with an empty secret: %w", domain.ErrUnauthorized)
	}
	token, err := jwt.ParseWithClaims(
		tokenString,
		&claims,
		func(token *jwt.Token) (any, error) {
			if token.Method != jwt.SigningMethodHS256 {
				return nil, fmt.Errorf("emailchange: unexpected signing method: %w", domain.ErrUnauthorized)
			}
			return s.secret, nil
		},
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
		jwt.WithIssuer(Issuer),
		jwt.WithAudience(Audience),
	)
	if err != nil {
		if errors.Is(err, domain.ErrUnauthorized) {
			return Claims{}, err
		}
		return Claims{}, fmt.Errorf("emailchange: parse token: %w", domain.ErrUnauthorized)
	}
	if !token.Valid {
		return Claims{}, fmt.Errorf("emailchange: invalid token: %w", domain.ErrUnauthorized)
	}
	if claims.Purpose != Purpose {
		return Claims{}, fmt.Errorf("emailchange: unexpected purpose: %w", domain.ErrUnauthorized)
	}
	if claims.UserID == "" || claims.OldEmail == "" || claims.NewEmail == "" {
		return Claims{}, fmt.Errorf("emailchange: missing identity: %w", domain.ErrUnauthorized)
	}
	return claims, nil
}
