package auth

import (
	"context"
	"encoding/base64"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"

	"thc-vms/backend/internal/domain"
)

// fakeResetRow is one stored token digest in the hand-written fake of
// domain.PasswordResetTokenRepository.
type fakeResetRow struct {
	userID      domain.UUID
	expiresAt   time.Time
	consumed    bool
	requestedIP *string
}

// fakePasswordResets is a hand-written fake of the token store: InsertToken
// records the digest row, ConsumeToken enforces the same one-query gate as
// the SQL adapter (hash match AND unexpired AND unconsumed) and applies the
// consume stamp plus the password rotation as one indivisible map write, so
// the tests prove the single-use contract end to end through the fakeUsers
// row the login path reads.
type fakePasswordResets struct {
	users     *fakeUsers
	rows      map[string]*fakeResetRow
	inserts   int
	insertErr error
}

func newFakePasswordResets(users *fakeUsers) *fakePasswordResets {
	return &fakePasswordResets{users: users, rows: map[string]*fakeResetRow{}}
}

func (f *fakePasswordResets) InsertToken(_ context.Context, userID domain.UUID, tokenHash string, expiresAt time.Time, requestedIP *string) error {
	if f.insertErr != nil {
		return f.insertErr
	}
	f.inserts++
	f.rows[tokenHash] = &fakeResetRow{userID: userID, expiresAt: expiresAt, requestedIP: requestedIP}
	return nil
}

func (f *fakePasswordResets) ConsumeToken(_ context.Context, tokenHash, newPasswordHash string, now time.Time) (domain.UUID, error) {
	row, ok := f.rows[tokenHash]
	if !ok || row.consumed || !row.expiresAt.After(now) {
		return "", domain.ErrNotFound
	}
	row.consumed = true
	user, ok := f.users.byID[row.userID]
	if !ok {
		return "", domain.ErrNotFound
	}
	user.PasswordHash = newPasswordHash
	f.users.byID[row.userID] = user
	f.users.byEmail[user.Email] = user
	return row.userID, nil
}

// passwordResetSvc wires a Service whose clock is frozen at now: the expiry
// assertions pin expires_at to now + 30 minutes exactly.
func passwordResetSvc(users *fakeUsers, now time.Time) (*Service, *fakePasswordResets, *domain.FakeMailer, *fakeAudit) {
	resets := newFakePasswordResets(users)
	mailer := &domain.FakeMailer{}
	audit := &fakeAudit{}
	deps := loginDeps(users)
	deps.Resets = resets
	deps.Mailer = mailer
	deps.Audit = audit
	deps.Clock = fakeClock{now: now}
	return NewService(deps), resets, mailer, audit
}

func resetNow() time.Time {
	return time.Date(2026, time.November, 12, 10, 0, 0, 0, time.UTC)
}

// resetRawFromMail extracts the raw bearer from the single reset mail: the
// link is the only channel that ever carries it, mirroring how the real
// account holder receives it.
func resetRawFromMail(t *testing.T, mailer *domain.FakeMailer) string {
	t.Helper()
	if len(mailer.Calls) != 1 {
		t.Fatalf("mailer calls = %d, want exactly 1 reset mail", len(mailer.Calls))
	}
	const marker = "/reset-password?token="
	body := mailer.Calls[0].TextBody
	i := strings.Index(body, marker)
	if i < 0 {
		t.Fatalf("reset mail carries no %q link", marker)
	}
	raw := body[i+len(marker):]
	if j := strings.IndexAny(raw, " \n\r\t"); j >= 0 {
		raw = raw[:j]
	}
	if raw == "" {
		t.Fatal("reset link carries an empty token")
	}
	return raw
}

func assertResetLinkInvalid(t *testing.T, err error) {
	t.Helper()
	appErr := appErrorOf(t, err)
	if appErr.Status != 401 || appErr.Code != "UNAUTHORIZED" || appErr.Message != "Tautan tidak valid atau kedaluwarsa." {
		t.Fatalf("error = %d/%s/%q, want 401/UNAUTHORIZED/link-invalid", appErr.Status, appErr.Code, appErr.Message)
	}
}

// TestRequestPasswordReset_HappyPathMintsRowAndSendsMail pins the request
// contract: the email is normalised, exactly one digest row lands with a
// 64-hex SHA-256 (decoding to the 32 raw bytes mailed), expiring in exactly
// 30 minutes, one mail reaches the account inbox carrying the link, and the
// audit trail names the flow secret-free.
func TestRequestPasswordReset_HappyPathMintsRowAndSendsMail(t *testing.T) {
	users, user := seedSelfUser(t, domain.RoleAdmin)
	now := resetNow()
	svc, resets, mailer, audit := passwordResetSvc(users, now)

	if err := svc.RequestPasswordReset(auditCtx(), "  SELF@thc.local ", "203.0.113.9"); err != nil {
		t.Fatalf("RequestPasswordReset: %v", err)
	}
	if resets.inserts != 1 || len(resets.rows) != 1 {
		t.Fatalf("token rows = %d (inserts %d), want exactly 1", len(resets.rows), resets.inserts)
	}
	raw := resetRawFromMail(t, mailer)
	call := mailer.Calls[0]
	if len(call.To) != 1 || call.To[0] != "self@thc.local" {
		t.Fatalf("mail to = %v, want the normalised account inbox", call.To)
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil || len(decoded) != 32 {
		t.Fatalf("raw token decodes to %d bytes (err %v), want 32 random bytes", len(decoded), err)
	}
	digest := hashPasswordResetToken(raw)
	row, ok := resets.rows[digest]
	if !ok {
		t.Fatal("stored digest is not the SHA-256 hex of the mailed raw token")
	}
	if len(digest) != 64 {
		t.Fatalf("stored digest length = %d, want 64 hex chars", len(digest))
	}
	if !row.expiresAt.Equal(now.Add(30 * time.Minute)) {
		t.Fatalf("expires_at = %v, want now + 30m", row.expiresAt)
	}
	if row.userID != user.ID {
		t.Fatalf("row user = %q, want %q", row.userID, user.ID)
	}
	if row.requestedIP == nil || *row.requestedIP != "203.0.113.9" {
		t.Fatalf("requested_ip = %v, want the caller IP", row.requestedIP)
	}
	if len(audit.entries) != 1 {
		t.Fatalf("audit entries = %d, want exactly 1", len(audit.entries))
	}
	entry := audit.entries[0]
	if entry.Action != domain.AuditActionUserUpdate {
		t.Fatalf("audit action = %q, want user.update", entry.Action)
	}
	if entry.Metadata["source"] != "password-reset" || entry.Metadata["fields"] != "password" {
		t.Fatalf("audit metadata = %v, want source password-reset + fields password", entry.Metadata)
	}
	for key, value := range entry.Metadata {
		if strings.Contains(value, raw) || strings.Contains(value, digest) {
			t.Fatalf("audit metadata[%q] leaks the token or its digest", key)
		}
	}
}

// TestRequestPasswordReset_UnknownEmailSilentSuccess proves the oracle guard:
// an unknown address succeeds with NO row, NO mail, and NO audit entry.
func TestRequestPasswordReset_UnknownEmailSilentSuccess(t *testing.T) {
	users, _ := seedSelfUser(t, domain.RoleAdmin)
	svc, resets, mailer, audit := passwordResetSvc(users, resetNow())

	if err := svc.RequestPasswordReset(auditCtx(), "ghost@thc.local", ""); err != nil {
		t.Fatalf("unknown email must succeed silently, got: %v", err)
	}
	if len(resets.rows) != 0 {
		t.Fatalf("token rows = %d for an unknown email, want 0", len(resets.rows))
	}
	if len(mailer.Calls) != 0 {
		t.Fatalf("mailer calls = %d for an unknown email, want 0", len(mailer.Calls))
	}
	if len(audit.entries) != 0 {
		t.Fatalf("audit entries = %d for an unknown email, want 0", len(audit.entries))
	}
}

// TestRequestPasswordReset_StatusGates mirrors the login gates exactly:
// pending waits, inactive refuses, any other non-active status renders the
// generic 401 — and none of them mints a row or a mail.
func TestRequestPasswordReset_StatusGates(t *testing.T) {
	for _, tc := range []struct {
		name       string
		status     domain.UserStatus
		wantStatus int
		wantCode   string
		wantMsg    string
	}{
		{"pending", domain.UserStatusPending, 403, "ACCOUNT_PENDING", "Akun Anda menunggu persetujuan superadmin."},
		{"inactive", domain.UserStatusInactive, 403, "ACCOUNT_INACTIVE", "Akun Anda dinonaktifkan."},
		{"blacklisted", domain.UserStatusBlacklisted, 401, "INVALID_CREDENTIALS", "Kredensial tidak valid"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			users, user := seedSelfUser(t, domain.RoleAdmin)
			user.Status = tc.status
			users.byID[user.ID] = user
			users.byEmail[user.Email] = user
			svc, resets, mailer, _ := passwordResetSvc(users, resetNow())

			err := svc.RequestPasswordReset(context.Background(), "self@thc.local", "")
			if err == nil {
				t.Fatalf("%s account: request succeeded, want %d/%s", tc.name, tc.wantStatus, tc.wantCode)
			}
			appErr := appErrorOf(t, err)
			if appErr.Status != tc.wantStatus || appErr.Code != tc.wantCode || appErr.Message != tc.wantMsg {
				t.Fatalf("error = %d/%s/%q, want %d/%s/%q",
					appErr.Status, appErr.Code, appErr.Message, tc.wantStatus, tc.wantCode, tc.wantMsg)
			}
			if len(resets.rows) != 0 || len(mailer.Calls) != 0 {
				t.Fatalf("gated account minted rows=%d mails=%d, want 0/0", len(resets.rows), len(mailer.Calls))
			}
		})
	}
}

// TestRequestPasswordReset_BadEmailShape proves a malformed address is 422
// with the domain message before any lookup happens.
func TestRequestPasswordReset_BadEmailShape(t *testing.T) {
	for _, raw := range []string{"", "   ", "bukan-email", "A <a@b.co>", "self@thc.local@"} {
		t.Run("shape:"+raw, func(t *testing.T) {
			users, _ := seedSelfUser(t, domain.RoleAdmin)
			svc, resets, mailer, _ := passwordResetSvc(users, resetNow())

			err := svc.RequestPasswordReset(context.Background(), raw, "")
			if err == nil {
				t.Fatalf("RequestPasswordReset(%q) succeeded, want 422", raw)
			}
			appErr := appErrorOf(t, err)
			if appErr.Status != 422 || appErr.Code != "VALIDATION_ERROR" || appErr.Message != "Format email tidak valid." {
				t.Fatalf("error = %d/%s/%q, want 422/VALIDATION_ERROR/format", appErr.Status, appErr.Code, appErr.Message)
			}
			if len(resets.rows) != 0 || len(mailer.Calls) != 0 {
				t.Fatalf("bad shape minted rows=%d mails=%d, want 0/0", len(resets.rows), len(mailer.Calls))
			}
		})
	}
}

// TestConfirmPasswordReset_HappyPathFlipsPasswordAndConsumes proves the full
// redemption: the mailed bearer flips the stored hash (new verifies, old
// stops), the row is consumed, and the audit trail records the confirm
// secret-free.
func TestConfirmPasswordReset_HappyPathFlipsPasswordAndConsumes(t *testing.T) {
	users, user := seedSelfUser(t, domain.RoleAdmin)
	now := resetNow()
	svc, resets, mailer, audit := passwordResetSvc(users, now)
	if err := svc.RequestPasswordReset(auditCtx(), "self@thc.local", ""); err != nil {
		t.Fatalf("RequestPasswordReset: %v", err)
	}
	raw := resetRawFromMail(t, mailer)
	oldHash := users.byID[user.ID].PasswordHash

	if err := svc.ConfirmPasswordReset(auditCtx(), raw, "Baru12345!"); err != nil {
		t.Fatalf("ConfirmPasswordReset: %v", err)
	}
	stored := users.byID[user.ID]
	if stored.PasswordHash == oldHash {
		t.Fatal("stored hash unchanged after confirm")
	}
	if err := bcrypt.CompareHashAndPassword([]byte(stored.PasswordHash), []byte("Baru12345!")); err != nil {
		t.Fatalf("new password does not verify: %v", err)
	}
	if err := bcrypt.CompareHashAndPassword([]byte(stored.PasswordHash), []byte("Password123!")); err == nil {
		t.Fatal("old password still verifies after confirm")
	}
	if strings.Contains(stored.PasswordHash, "Baru12345!") {
		t.Fatal("plaintext password reached the stored hash")
	}
	if !resets.rows[hashPasswordResetToken(raw)].consumed {
		t.Fatal("token row not marked consumed after confirm")
	}
	if len(audit.entries) != 2 {
		t.Fatalf("audit entries = %d, want request + confirm", len(audit.entries))
	}
	for _, entry := range audit.entries {
		for key, value := range entry.Metadata {
			if strings.Contains(value, raw) {
				t.Fatalf("audit metadata[%q] leaks the raw token", key)
			}
		}
	}
}

// TestConfirmPasswordReset_SecondConfirmRejected proves single use: replaying
// the same bearer renders the byte-identical 401 even with a fresh password.
func TestConfirmPasswordReset_SecondConfirmRejected(t *testing.T) {
	users, _ := seedSelfUser(t, domain.RoleAdmin)
	svc, _, mailer, _ := passwordResetSvc(users, resetNow())
	if err := svc.RequestPasswordReset(context.Background(), "self@thc.local", ""); err != nil {
		t.Fatalf("RequestPasswordReset: %v", err)
	}
	raw := resetRawFromMail(t, mailer)
	if err := svc.ConfirmPasswordReset(context.Background(), raw, "Baru12345!"); err != nil {
		t.Fatalf("first ConfirmPasswordReset: %v", err)
	}
	assertResetLinkInvalid(t, svc.ConfirmPasswordReset(context.Background(), raw, "Lain67890!"))
}

// TestConfirmPasswordReset_InvalidTokensByteIdentical proves expired,
// tampered, and unknown bearers all render the exact same 401 envelope, so
// confirm responses never distinguish the failure cause.
func TestConfirmPasswordReset_InvalidTokensByteIdentical(t *testing.T) {
	users, _ := seedSelfUser(t, domain.RoleAdmin)
	now := resetNow()
	svc, resets, mailer, _ := passwordResetSvc(users, now)
	if err := svc.RequestPasswordReset(context.Background(), "self@thc.local", ""); err != nil {
		t.Fatalf("RequestPasswordReset: %v", err)
	}
	raw := resetRawFromMail(t, mailer)

	tampered := raw[:len(raw)-1] + "A"
	if tampered == raw {
		tampered = raw[:len(raw)-1] + "B"
	}
	expiredRaw := "expired-bearer-token"
	resets.rows[hashPasswordResetToken(expiredRaw)] = &fakeResetRow{
		userID:    "user-self-1",
		expiresAt: now.Add(-time.Second),
	}

	for _, tc := range []struct {
		name  string
		token string
	}{
		{"expired", expiredRaw},
		{"tampered", tampered},
		{"unknown", "bearer-tidak-pernah-diterbitkan"},
		{"empty", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assertResetLinkInvalid(t, svc.ConfirmPasswordReset(context.Background(), tc.token, "Baru12345!"))
		})
	}
}

// TestConfirmPasswordReset_WeakPasswordRejected proves the shared policy
// guards the confirm: a short password is 400 with the policy message, an
// empty one with the blank message, neither touches the stored hash, and the
// token stays live so a later strong confirm still succeeds.
func TestConfirmPasswordReset_WeakPasswordRejected(t *testing.T) {
	for _, tc := range []struct {
		name    string
		next    string
		message string
	}{
		{"too short", "pendek", "Kata sandi minimal 8 karakter."},
		{"empty", "", "Kata sandi minimal 8 karakter."},
	} {
		t.Run(tc.name, func(t *testing.T) {
			users, user := seedSelfUser(t, domain.RoleAdmin)
			oldHash := user.PasswordHash
			svc, resets, mailer, _ := passwordResetSvc(users, resetNow())
			if err := svc.RequestPasswordReset(context.Background(), "self@thc.local", ""); err != nil {
				t.Fatalf("RequestPasswordReset: %v", err)
			}
			raw := resetRawFromMail(t, mailer)

			err := svc.ConfirmPasswordReset(context.Background(), raw, tc.next)
			if err == nil {
				t.Fatal("weak password accepted, want 400")
			}
			appErr := appErrorOf(t, err)
			if appErr.Status != 400 || appErr.Code != "VALIDATION_ERROR" || appErr.Message != tc.message {
				t.Fatalf("error = %d/%s/%q, want 400/VALIDATION_ERROR/%q",
					appErr.Status, appErr.Code, appErr.Message, tc.message)
			}
			if stored := users.byID[user.ID]; stored.PasswordHash != oldHash {
				t.Fatal("stored hash changed on a refused confirm")
			}
			if resets.rows[hashPasswordResetToken(raw)].consumed {
				t.Fatal("token consumed by a refused confirm")
			}
			if err := svc.ConfirmPasswordReset(context.Background(), raw, "Baru12345!"); err != nil {
				t.Fatalf("strong confirm after a refused one: %v", err)
			}
		})
	}
}
