package domain

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

// Given the TTL contract, when the constant is read, then it is exactly 30
// minutes, so the usecase and the migration expiry agree on one duration.
func TestPasswordResetTokenTTL_IsThirtyMinutes(t *testing.T) {
	if PasswordResetTokenTTL != 30*time.Minute {
		t.Fatalf("PasswordResetTokenTTL = %v, want 30m0s", PasswordResetTokenTTL)
	}
}

// Given malformed addresses, when the request is validated, then each is
// refused with the exact 422 VALIDATION_ERROR envelope, so no new vocabulary
// leaks into the contract.
func TestValidatePasswordResetRequest_InvalidEmailRejected(t *testing.T) {
	cases := []string{"", "   ", "bukan-email", "A <a@b.co>", "@b.co", "foo@"}
	for _, raw := range cases {
		_, err := ValidatePasswordResetRequest(raw)
		if err == nil {
			t.Fatalf("ValidatePasswordResetRequest(%q) = nil, want 422", raw)
		}
		appErr, ok := err.(*AppError)
		if !ok {
			t.Fatalf("ValidatePasswordResetRequest(%q) error type = %T, want *AppError", raw, err)
		}
		if appErr.Status != http.StatusUnprocessableEntity {
			t.Fatalf("ValidatePasswordResetRequest(%q) status = %d, want 422", raw, appErr.Status)
		}
		if appErr.Code != "VALIDATION_ERROR" {
			t.Fatalf("ValidatePasswordResetRequest(%q) code = %q, want VALIDATION_ERROR", raw, appErr.Code)
		}
		if appErr.Message != "Format email tidak valid." {
			t.Fatalf("ValidatePasswordResetRequest(%q) message = %q, want %q", raw, appErr.Message, "Format email tidak valid.")
		}
		if !errors.Is(err, ErrValidation) {
			t.Fatalf("ValidatePasswordResetRequest(%q) must wrap ErrValidation", raw)
		}
	}
}

// Given a well-formed address with noise, when the request is validated, then
// it succeeds with the trimmed lowercase form, mirroring login normalisation.
func TestValidatePasswordResetRequest_NormalisesEmail(t *testing.T) {
	got, err := ValidatePasswordResetRequest("  Foo@Example.COM ")
	if err != nil {
		t.Fatalf("ValidatePasswordResetRequest valid = %v, want nil", err)
	}
	if got.Email != "foo@example.com" {
		t.Fatalf("email = %q, want %q", got.Email, "foo@example.com")
	}
}

// Given overlong input, when the request is validated, then it is refused:
// more than 254 runes never reaches a query.
func TestValidatePasswordResetRequest_TooLongRejected(t *testing.T) {
	raw := strings.Repeat("a", 250) + "@b.co"
	if _, err := ValidatePasswordResetRequest(raw); err == nil {
		t.Fatal("overlong email accepted, want 422")
	}
}

// Given a failed reset confirm, when the link error is built, then it is the
// byte-identical 401 UNAUTHORIZED email-change tone wrapping ErrUnauthorized,
// so FromError funnels even a wrapped sentinel to the same envelope.
func TestPasswordResetLinkInvalid_EnvelopeExact(t *testing.T) {
	appErr := PasswordResetLinkInvalid()
	if appErr.Status != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", appErr.Status)
	}
	if appErr.Code != "UNAUTHORIZED" {
		t.Fatalf("code = %q, want UNAUTHORIZED", appErr.Code)
	}
	const want = "Tautan tidak valid atau kedaluwarsa."
	if appErr.Message != want {
		t.Fatalf("message = %q, want %q", appErr.Message, want)
	}
	funneled := FromError(PasswordResetLinkInvalid())
	if funneled.Status != http.StatusUnauthorized || funneled.Code != "UNAUTHORIZED" || funneled.Message != want {
		t.Fatalf("funneled = (%d,%s,%q), want (401,UNAUTHORIZED,%q)", funneled.Status, funneled.Code, funneled.Message, want)
	}
	wrapped := FromError(fmt.Errorf("confirm: %w", PasswordResetLinkInvalid()))
	if wrapped.Code != "UNAUTHORIZED" || wrapped.Message != want {
		t.Fatalf("wrapped funnel = (%s,%q), want (UNAUTHORIZED,%q)", wrapped.Code, wrapped.Message, want)
	}
}

// Given an issuance instant, when the expiry helper runs, then it lands
// exactly TTL later and the expired check flips only after that instant.
func TestPasswordResetExpiry_Boundary(t *testing.T) {
	issued := time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC)
	if got := PasswordResetExpiresAt(issued); !got.Equal(issued.Add(30 * time.Minute)) {
		t.Fatalf("expires = %v, want issued+30m", got)
	}
	if PasswordResetTokenExpired(issued.Add(29*time.Minute), issued.Add(29*time.Minute)) {
		t.Fatal("token inside window reported expired")
	}
	if PasswordResetTokenExpired(issued, issued.Add(30*time.Minute)) {
		t.Fatal("token exactly at TTL reported expired")
	}
	if !PasswordResetTokenExpired(issued, issued.Add(30*time.Minute+time.Second)) {
		t.Fatal("token past TTL reported fresh")
	}
}
