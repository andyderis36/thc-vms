// Package emailchange tests the stateless HS256 email-change confirmation
// tokens. The covered contract: Mint/Verify round-trip preserves
// user_id/old_email/new_email with purpose=email-change, iss/aud=thc-vms and
// a 60-minute expiry; every deviation (wrong purpose, wrong iss/aud,
// expiry, tampering, empty secret) fails closed with an error.
package emailchange

import (
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const testSecret = "unit-test-emailchange-secret"

// mintWith streams one token through a throwaway service: the shared arrange
// step every case starts from.
func mintWith(t *testing.T, svc *Service) string {
	t.Helper()
	token, err := svc.Mint("11111111-1111-1111-1111-111111111111", "old@thc.id", "new@thc.id")
	if err != nil {
		t.Fatalf("Mint() error = %v", err)
	}
	if token == "" {
		t.Fatal("Mint() returned an empty token")
	}
	return token
}

// forge rebuilds a token with hand-set claims under the test secret: the only
// way to produce wrong-purpose / wrong-issuer / expired inputs the minter
// itself can never emit.
func forge(t *testing.T, mutate func(*Claims)) string {
	t.Helper()
	now := time.Now()
	claims := Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    Issuer,
			Audience:  jwt.ClaimStrings{Audience},
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(TTL)),
		},
		Purpose:  Purpose,
		UserID:   "11111111-1111-1111-1111-111111111111",
		OldEmail: "old@thc.id",
		NewEmail: "new@thc.id",
	}
	mutate(&claims)
	signed, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(testSecret))
	if err != nil {
		t.Fatalf("forge sign error = %v", err)
	}
	return signed
}

// TestMintVerify_RoundTrip proves a minted token verifies and carries the
// frozen claim set back unchanged.
func TestMintVerify_RoundTrip(t *testing.T) {
	svc := NewService(testSecret)
	got, err := svc.Verify(mintWith(t, svc))
	if err != nil {
		t.Fatalf("Verify() error = %v", err)
	}
	if got.Purpose != Purpose {
		t.Errorf("Purpose = %q, want %q", got.Purpose, Purpose)
	}
	if got.Issuer != Issuer {
		t.Errorf("Issuer = %q, want %q", got.Issuer, Issuer)
	}
	if len(got.Audience) != 1 || got.Audience[0] != Audience {
		t.Errorf("Audience = %v, want [%q]", got.Audience, Audience)
	}
	if string(got.UserID) != "11111111-1111-1111-1111-111111111111" {
		t.Errorf("UserID = %q, want the minted id", got.UserID)
	}
	if got.OldEmail != "old@thc.id" || got.NewEmail != "new@thc.id" {
		t.Errorf("emails = %q/%q, want old@thc.id/new@thc.id", got.OldEmail, got.NewEmail)
	}
	if got.ExpiresAt == nil {
		t.Fatal("ExpiresAt is nil, want a 60-minute expiry")
	}
	ttl := time.Until(got.ExpiresAt.Time)
	if ttl <= 59*time.Minute || ttl > 60*time.Minute {
		t.Errorf("expiry in %s, want ~60m", ttl)
	}
}

// TestVerify_WrongPurposeRejected proves a token carrying any purpose other
// than email-change is rejected even when the signature is valid.
func TestVerify_WrongPurposeRejected(t *testing.T) {
	svc := NewService(testSecret)
	token := forge(t, func(c *Claims) { c.Purpose = "password-reset" })
	if _, err := svc.Verify(token); err == nil {
		t.Fatal("Verify() = nil error, want rejection of a foreign purpose")
	}
}

// TestVerify_WrongIssuerAudienceRejected proves tokens minted for another
// issuer/audience are rejected even when the signature is valid.
func TestVerify_WrongIssuerAudienceRejected(t *testing.T) {
	svc := NewService(testSecret)
	for _, tc := range []struct {
		name   string
		mutate func(*Claims)
	}{
		{"wrong issuer", func(c *Claims) { c.Issuer = "other-svc" }},
		{"wrong audience", func(c *Claims) { c.Audience = jwt.ClaimStrings{"other-svc"} }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := svc.Verify(forge(t, tc.mutate)); err == nil {
				t.Fatalf("Verify() = nil error, want rejection of %s", tc.name)
			}
		})
	}
}

// TestVerify_ExpiredRejected proves a token past its 60-minute expiry is
// rejected.
func TestVerify_ExpiredRejected(t *testing.T) {
	svc := NewService(testSecret)
	token := forge(t, func(c *Claims) {
		c.ExpiresAt = jwt.NewNumericDate(time.Now().Add(-time.Minute))
	})
	if _, err := svc.Verify(token); err == nil {
		t.Fatal("Verify() = nil error, want rejection of an expired token")
	}
}

// TestVerify_TamperedSignatureRejected proves flipping one payload character
// breaks verification: the token is integrity-protected.
func TestVerify_TamperedSignatureRejected(t *testing.T) {
	svc := NewService(testSecret)
	token := mintWith(t, svc)
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("token has %d segments, want 3", len(parts))
	}
	payload := parts[1]
	var flipped byte = 'A'
	if payload[len(payload)-1] == 'A' {
		flipped = 'B'
	}
	parts[1] = payload[:len(payload)-1] + string(flipped)
	if _, err := svc.Verify(strings.Join(parts, ".")); err == nil {
		t.Fatal("Verify() = nil error, want rejection of a tampered token")
	}
}

// TestEmptySecret_FailsClosed proves both Mint and Verify refuse to work
// without a secret instead of emitting or accepting unsigned trust.
func TestEmptySecret_FailsClosed(t *testing.T) {
	svc := NewService("")
	if _, err := svc.Mint("11111111-1111-1111-1111-111111111111", "old@thc.id", "new@thc.id"); err == nil {
		t.Error("Mint() with empty secret = nil error, want fail-closed")
	}
	valid := forge(t, func(*Claims) {})
	if _, err := svc.Verify(valid); err == nil {
		t.Error("Verify() with empty secret = nil error, want fail-closed")
	}
}
