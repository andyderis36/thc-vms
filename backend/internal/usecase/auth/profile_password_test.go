package auth

import (
	"context"
	"strings"
	"testing"

	"golang.org/x/crypto/bcrypt"

	"thc-vms/backend/internal/domain"
)

// TestUpdateSelf_PasswordSuccessRotatesHash proves the self-service rotation
// for every role (including super_admin and the hidden dev-superadmin through
// the exact same path): a password-only request succeeds, the stored hash
// verifies against the new password (and no longer the old one), and the
// other profile fields are untouched.
func TestUpdateSelf_PasswordSuccessRotatesHash(t *testing.T) {
	roles := []domain.RoleName{
		domain.RoleSuperAdmin,
		domain.RoleDevSuperAdmin,
		domain.RoleAdmin,
		domain.RoleSecurity,
		domain.RoleVendor,
	}
	for _, role := range roles {
		t.Run(string(role), func(t *testing.T) {
			users, user := seedSelfUser(t, role)
			profiles := &fakeProfiles{users: users}
			svc := selfService(users, profiles, &fakeSelfStorage{})
			oldHash := user.PasswordHash

			_, err := svc.UpdateSelf(context.Background(),
				SelfIdentity{UserID: user.ID, Role: role},
				SelfUpdate{
					NewPassword:     stringPtr("Baru12345!"),
					CurrentPassword: stringPtr("Password123!"),
				})
			if err != nil {
				t.Fatalf("UpdateSelf password rotation: %v", err)
			}
			if profiles.calls != 1 {
				t.Fatalf("UpdateProfile calls = %d, want 1", profiles.calls)
			}
			stored := users.byID[user.ID]
			if stored.PasswordHash == oldHash {
				t.Fatal("stored hash unchanged after rotation")
			}
			if err := bcrypt.CompareHashAndPassword([]byte(stored.PasswordHash), []byte("Baru12345!")); err != nil {
				t.Fatalf("new password does not verify: %v", err)
			}
			if err := bcrypt.CompareHashAndPassword([]byte(stored.PasswordHash), []byte("Password123!")); err == nil {
				t.Fatal("old password still verifies after rotation")
			}
			if stored.Name != user.Name || stored.Phone != user.Phone || stored.AvatarURL != user.AvatarURL {
				t.Fatalf("profile fields changed by a password-only rotation: %+v", stored)
			}
			if strings.Contains(profiles.lastUpdate.PasswordHash, "Baru12345!") {
				t.Fatal("plaintext password reached the repository port")
			}
		})
	}
}

// TestUpdateSelf_PasswordWrongCurrentRefused proves a wrong current password
// is 401 INVALID_CREDENTIALS with the exact message and never touches the
// repository.
func TestUpdateSelf_PasswordWrongCurrentRefused(t *testing.T) {
	users, user := seedSelfUser(t, domain.RoleAdmin)
	profiles := &fakeProfiles{users: users}
	svc := selfService(users, profiles, &fakeSelfStorage{})

	_, err := svc.UpdateSelf(context.Background(),
		SelfIdentity{UserID: user.ID, Role: domain.RoleAdmin},
		SelfUpdate{
			NewPassword:     stringPtr("Baru12345!"),
			CurrentPassword: stringPtr("Salah12345!"),
		})
	if err == nil {
		t.Fatal("rotation with wrong current password succeeded, want 401")
	}
	appErr := appErrorOf(t, err)
	if appErr.Status != 401 || appErr.Code != "INVALID_CREDENTIALS" {
		t.Fatalf("error = %d/%s, want 401/INVALID_CREDENTIALS", appErr.Status, appErr.Code)
	}
	if appErr.Message != "Password saat ini salah." {
		t.Fatalf("message = %q, want %q", appErr.Message, "Password saat ini salah.")
	}
	if profiles.calls != 0 {
		t.Fatalf("UpdateProfile calls = %d, want 0", profiles.calls)
	}
	if stored := users.byID[user.ID]; stored.PasswordHash != user.PasswordHash {
		t.Fatal("stored hash changed on a refused rotation")
	}
}

// TestUpdateSelf_PasswordRequiresCurrent proves a rotation without takeover
// proof is 400 and writes nothing (both an absent and an empty proof).
func TestUpdateSelf_PasswordRequiresCurrent(t *testing.T) {
	for _, tc := range []struct {
		name    string
		current *string
	}{
		{"absent", nil},
		{"empty", stringPtr("")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			users, user := seedSelfUser(t, domain.RoleVendor)
			profiles := &fakeProfiles{users: users}
			svc := selfService(users, profiles, &fakeSelfStorage{})

			_, err := svc.UpdateSelf(context.Background(),
				SelfIdentity{UserID: user.ID, Role: domain.RoleVendor},
				SelfUpdate{NewPassword: stringPtr("Baru12345!"), CurrentPassword: tc.current})
			if err == nil {
				t.Fatal("rotation without current password succeeded, want 400")
			}
			appErr := appErrorOf(t, err)
			if appErr.Status != 400 || appErr.Code != "VALIDATION_ERROR" {
				t.Fatalf("error = %d/%s, want 400/VALIDATION_ERROR", appErr.Status, appErr.Code)
			}
			if profiles.calls != 0 {
				t.Fatalf("UpdateProfile calls = %d, want 0", profiles.calls)
			}
		})
	}
}

// TestUpdateSelf_PasswordWeakNewRefused proves the shared password policy
// guards the rotation: a short password is 400 with the policy message, an
// empty one with the blank message, and neither writes.
func TestUpdateSelf_PasswordWeakNewRefused(t *testing.T) {
	for _, tc := range []struct {
		name    string
		next    string
		message string
	}{
		{"too short", "pendek", "Kata sandi minimal 8 karakter."},
		{"empty", "", "Password baru tidak boleh kosong."},
		{"blank", "   ", "Password baru tidak boleh kosong."},
	} {
		t.Run(tc.name, func(t *testing.T) {
			users, user := seedSelfUser(t, domain.RoleSecurity)
			profiles := &fakeProfiles{users: users}
			svc := selfService(users, profiles, &fakeSelfStorage{})

			_, err := svc.UpdateSelf(context.Background(),
				SelfIdentity{UserID: user.ID, Role: domain.RoleSecurity},
				SelfUpdate{
					NewPassword:     stringPtr(tc.next),
					CurrentPassword: stringPtr("Password123!"),
				})
			if err == nil {
				t.Fatal("weak new password accepted, want 400")
			}
			appErr := appErrorOf(t, err)
			if appErr.Status != 400 || appErr.Code != "VALIDATION_ERROR" {
				t.Fatalf("error = %d/%s, want 400/VALIDATION_ERROR", appErr.Status, appErr.Code)
			}
			if appErr.Message != tc.message {
				t.Fatalf("message = %q, want %q", appErr.Message, tc.message)
			}
			if profiles.calls != 0 {
				t.Fatalf("UpdateProfile calls = %d, want 0", profiles.calls)
			}
		})
	}
}

// TestUpdateSelf_PasswordCombinedWithProfileFields proves a rotation composes
// with a profile edit in one request: both land in the single repository
// write.
func TestUpdateSelf_PasswordCombinedWithProfileFields(t *testing.T) {
	users, user := seedSelfUser(t, domain.RoleVendor)
	profiles := &fakeProfiles{users: users}
	svc := selfService(users, profiles, &fakeSelfStorage{})

	if _, err := svc.UpdateSelf(context.Background(),
		SelfIdentity{UserID: user.ID, Role: domain.RoleVendor},
		SelfUpdate{
			Phone:           stringPtr("081298765432"),
			NewPassword:     stringPtr("Baru12345!"),
			CurrentPassword: stringPtr("Password123!"),
		}); err != nil {
		t.Fatalf("UpdateSelf: %v", err)
	}
	if profiles.calls != 1 {
		t.Fatalf("UpdateProfile calls = %d, want exactly 1", profiles.calls)
	}
	stored := users.byID[user.ID]
	if stored.Phone != "081298765432" {
		t.Fatalf("stored phone = %q, want the new number", stored.Phone)
	}
	if err := bcrypt.CompareHashAndPassword([]byte(stored.PasswordHash), []byte("Baru12345!")); err != nil {
		t.Fatalf("new password does not verify: %v", err)
	}
}

// TestUpdateSelf_PasswordAuditNamesRotation proves the audit trail names the
// rotation secret-free: the fields list carries "password" while no metadata
// value holds a password or hash.
func TestUpdateSelf_PasswordAuditNamesRotation(t *testing.T) {
	users, user := seedSelfUser(t, domain.RoleAdmin)
	profiles := &fakeProfiles{users: users}
	audit := &fakeAudit{}
	deps := loginDeps(users)
	deps.Profiles = profiles
	deps.Audit = audit
	svc := NewService(deps)

	if _, err := svc.UpdateSelf(auditCtx(),
		SelfIdentity{UserID: user.ID, Role: domain.RoleAdmin},
		SelfUpdate{
			NewPassword:     stringPtr("Baru12345!"),
			CurrentPassword: stringPtr("Password123!"),
		}); err != nil {
		t.Fatalf("UpdateSelf: %v", err)
	}
	if len(audit.entries) != 1 {
		t.Fatalf("audit entries = %d, want exactly 1", len(audit.entries))
	}
	entry := audit.entries[0]
	if entry.Metadata["fields"] != "password" {
		t.Fatalf("metadata fields = %q, want %q", entry.Metadata["fields"], "password")
	}
	for key, value := range entry.Metadata {
		if strings.Contains(value, "Baru12345!") || strings.Contains(value, "Password123!") {
			t.Fatalf("metadata[%q] leaks a secret", key)
		}
	}
}
