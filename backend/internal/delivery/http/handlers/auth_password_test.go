package handlers_test

import (
	"net/http"
	"testing"

	"thc-vms/backend/internal/domain"
)

// TestPatchMe_ForwardsPasswordRotation proves the new rotation keys travel
// verbatim to the usecase: new_password + current_password are accepted
// members (unlike the legacy "password" key, which stays 400).
func TestPatchMe_ForwardsPasswordRotation(t *testing.T) {
	svc := &stubAuthService{profile: cannedSelfProfile()}
	engine := newAuthEngine(svc, domain.RoleVendor, "")

	rec := serveJSON(engine, "PATCH", "/auth/me", `{"new_password":"Baru12345!","current_password":"Lama12345!"}`)
	mustStatus(t, rec, http.StatusOK)
	if svc.updateSelfCalls != 1 {
		t.Fatalf("usecase calls = %d, want exactly 1", svc.updateSelfCalls)
	}
	if svc.lastSelfUpdate.NewPassword == nil || *svc.lastSelfUpdate.NewPassword != "Baru12345!" {
		t.Fatalf("new_password not forwarded: %+v", svc.lastSelfUpdate)
	}
	if svc.lastSelfUpdate.CurrentPassword == nil || *svc.lastSelfUpdate.CurrentPassword != "Lama12345!" {
		t.Fatalf("current_password not forwarded: %+v", svc.lastSelfUpdate)
	}
}

// TestPatchMe_PassesPasswordRefusalsThrough proves a 401 wrong-current-password
// from the usecase reaches the client byte-for-byte (never remapped to 400).
func TestPatchMe_PassesPasswordRefusalsThrough(t *testing.T) {
	const message = "Password saat ini salah."
	svc := &stubAuthService{
		profile:       cannedSelfProfile(),
		updateSelfErr: &domain.AppError{Status: http.StatusUnauthorized, Code: "INVALID_CREDENTIALS", Message: message},
	}
	engine := newAuthEngine(svc, domain.RoleAdmin, "")

	rec := serveJSON(engine, "PATCH", "/auth/me", `{"new_password":"Baru12345!","current_password":"Salah12345!"}`)
	mustStatus(t, rec, http.StatusUnauthorized)
	env := decodeEnvelope(t, rec)
	if env.Error == nil || env.Error.Code != "INVALID_CREDENTIALS" || env.Error.Message != message {
		t.Fatalf("401 envelope not passed through: %q", rec.Body.String())
	}
}
