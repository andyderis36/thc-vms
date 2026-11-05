package auth

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"thc-vms/backend/internal/domain"
)

// fakeEmailTokens is a hand-written fake of the stateless email-change token
// port: Mint records every call, auto-registers the claims it minted (so a
// returned token verifies) and returns a deterministic token; Verify looks the
// token up, failing closed for unknown tokens exactly like an expired or
// tampered JWT.
type fakeEmailTokens struct {
	mints     []emailMintCall
	mintErr   error
	claims    map[string]EmailChangeClaims
	verifyErr error
}

type emailMintCall struct {
	userID   domain.UUID
	oldEmail string
	newEmail string
}

func newFakeEmailTokens() *fakeEmailTokens {
	return &fakeEmailTokens{claims: map[string]EmailChangeClaims{}}
}

func (f *fakeEmailTokens) Mint(userID domain.UUID, oldEmail, newEmail string) (string, error) {
	if f.mintErr != nil {
		return "", f.mintErr
	}
	f.mints = append(f.mints, emailMintCall{userID: userID, oldEmail: oldEmail, newEmail: newEmail})
	token := fmt.Sprintf("email-token-%d", len(f.mints))
	f.claims[token] = EmailChangeClaims{UserID: userID, OldEmail: oldEmail, NewEmail: newEmail}
	return token, nil
}

func (f *fakeEmailTokens) Verify(token string) (EmailChangeClaims, error) {
	if f.verifyErr != nil {
		return EmailChangeClaims{}, f.verifyErr
	}
	claims, ok := f.claims[token]
	if !ok {
		return EmailChangeClaims{}, fmt.Errorf("fake email token unknown: %w", domain.ErrUnauthorized)
	}
	return claims, nil
}

// emailProfiles is an email-aware fake of domain.ProfileRepository: it applies
// the fully resolved update (including the Email flip the shared fake in
// profile_update_test.go ignores) and keeps the byEmail lookup in sync so the
// login-still-works assertions prove the flip end to end.
type emailProfiles struct {
	users      *fakeUsers
	calls      int
	lastUpdate domain.ProfileUpdate
	err        error
}

func (f *emailProfiles) UpdateProfile(_ context.Context, id domain.UUID, update domain.ProfileUpdate) (domain.User, error) {
	f.calls++
	f.lastUpdate = update
	if f.err != nil {
		return domain.User{}, f.err
	}
	user, ok := f.users.byID[id]
	if !ok {
		return domain.User{}, domain.ErrNotFound
	}
	if update.Email != "" && !strings.EqualFold(update.Email, user.Email) {
		delete(f.users.byEmail, user.Email)
	}
	user.Name = update.Name
	user.Phone = update.Phone
	user.AvatarURL = update.AvatarURL
	if update.PasswordHash != "" {
		user.PasswordHash = update.PasswordHash
	}
	if update.Email != "" {
		user.Email = update.Email
	}
	f.users.byID[id] = user
	f.users.byEmail[user.Email] = user
	return user, nil
}

func emailChangeSvc(users *fakeUsers) (*Service, *fakeEmailTokens, *emailProfiles, *domain.FakeMailer, *fakeAudit) {
	profiles := &emailProfiles{users: users}
	tokens := newFakeEmailTokens()
	mailer := &domain.FakeMailer{}
	audit := &fakeAudit{}
	deps := loginDeps(users)
	deps.Profiles = profiles
	deps.EmailTokens = tokens
	deps.Mailer = mailer
	deps.Audit = audit
	return NewService(deps), tokens, profiles, mailer, audit
}

func assertEmailLinkInvalid(t *testing.T, err error) {
	t.Helper()
	appErr := appErrorOf(t, err)
	if appErr.Status != 401 || appErr.Code != "UNAUTHORIZED" || appErr.Message != "Tautan tidak valid atau kedaluwarsa." {
		t.Fatalf("error = %d/%s/%q, want 401/UNAUTHORIZED/link-invalid", appErr.Status, appErr.Code, appErr.Message)
	}
}

// TestRequestEmailChange_HappyPathSendsLinkWithoutStateChange pins the request
// contract: the new address is normalised, a token binding user->old->new is
// minted, exactly one verification mail reaches the NEW inbox carrying the
// token, and nothing is written (no profile call, stored email untouched, the
// old address still logs in).
func TestRequestEmailChange_HappyPathSendsLinkWithoutStateChange(t *testing.T) {
	users, user := seedSelfUser(t, domain.RoleAdmin)
	svc, tokens, profiles, mailer, audit := emailChangeSvc(users)

	token, err := svc.RequestEmailChange(context.Background(), user.ID, "self@thc.local", "  Baru@Example.COM ", "Password123!")
	if err != nil {
		t.Fatalf("RequestEmailChange: %v", err)
	}
	if token == "" {
		t.Fatal("empty token despite successful request")
	}
	if len(tokens.mints) != 1 {
		t.Fatalf("mint calls = %d, want 1", len(tokens.mints))
	}
	mint := tokens.mints[0]
	if mint.userID != user.ID || mint.oldEmail != "self@thc.local" || mint.newEmail != "baru@example.com" {
		t.Fatalf("mint = %+v, want user/old/new normalised", mint)
	}
	if len(mailer.Calls) != 1 {
		t.Fatalf("mailer calls = %d, want exactly 1 verification mail", len(mailer.Calls))
	}
	call := mailer.Calls[0]
	if len(call.To) != 1 || call.To[0] != "baru@example.com" {
		t.Fatalf("mail to = %v, want the NEW inbox only", call.To)
	}
	if !strings.Contains(call.TextBody, token) {
		t.Fatal("verification mail must carry the token")
	}
	if profiles.calls != 0 {
		t.Fatalf("UpdateProfile calls = %d, want 0 before confirm", profiles.calls)
	}
	if stored := users.byID[user.ID]; stored.Email != "self@thc.local" {
		t.Fatalf("stored email = %q, want unchanged until confirm", stored.Email)
	}
	if len(audit.entries) != 0 {
		t.Fatalf("audit entries = %d, want 0 before confirm", len(audit.entries))
	}
	if _, err := svc.Login(context.Background(), "self@thc.local", "Password123!"); err != nil {
		t.Fatalf("login with old email after request: %v", err)
	}
	if _, err := svc.Login(context.Background(), "baru@example.com", "Password123!"); err == nil {
		t.Fatal("login with new email succeeded before confirm, want failure")
	}
}

// TestRequestEmailChange_WrongPasswordIs401 pins the takeover proof: a bad
// current password is 401 INVALID_CREDENTIALS with the fixed message, and
// nothing is minted or mailed.
func TestRequestEmailChange_WrongPasswordIs401(t *testing.T) {
	users, user := seedSelfUser(t, domain.RoleAdmin)
	svc, tokens, _, mailer, _ := emailChangeSvc(users)

	_, err := svc.RequestEmailChange(context.Background(), user.ID, "self@thc.local", "baru@example.com", "WrongPassword!")
	if err == nil {
		t.Fatal("request with wrong password succeeded, want 401")
	}
	appErr := appErrorOf(t, err)
	if appErr.Status != 401 || appErr.Code != "INVALID_CREDENTIALS" || appErr.Message != "Password saat ini salah." {
		t.Fatalf("error = %d/%s/%q, want 401/INVALID_CREDENTIALS/fixed message", appErr.Status, appErr.Code, appErr.Message)
	}
	if len(tokens.mints) != 0 {
		t.Fatalf("mint calls = %d, want 0", len(tokens.mints))
	}
	if len(mailer.Calls) != 0 {
		t.Fatalf("mailer calls = %d, want 0", len(mailer.Calls))
	}
}

// TestRequestEmailChange_SameAsCurrentIs400 pins the no-op guard: asking to
// move to the address already stored (even cased/padded) is a 400 with no
// mint and no mail.
func TestRequestEmailChange_SameAsCurrentIs400(t *testing.T) {
	for _, raw := range []string{"self@thc.local", " SELF@THC.Local "} {
		users, user := seedSelfUser(t, domain.RoleVendor)
		svc, tokens, _, mailer, _ := emailChangeSvc(users)

		_, err := svc.RequestEmailChange(context.Background(), user.ID, "self@thc.local", raw, "Password123!")
		if err == nil {
			t.Fatalf("request to %q succeeded, want 400", raw)
		}
		appErr := appErrorOf(t, err)
		if appErr.Status != 400 {
			t.Fatalf("status = %d, want 400", appErr.Status)
		}
		if len(tokens.mints) != 0 || len(mailer.Calls) != 0 {
			t.Fatalf("mints = %d, mails = %d, want zero side effects", len(tokens.mints), len(mailer.Calls))
		}
	}
}

// TestRequestEmailChange_InvalidNewEmailIs400 pins format validation through
// validation.ValidEmail with no mint and no mail.
func TestRequestEmailChange_InvalidNewEmailIs400(t *testing.T) {
	for _, raw := range []string{"not-an-email", "A <a@b.co>", ""} {
		users, user := seedSelfUser(t, domain.RoleSecurity)
		svc, tokens, _, mailer, _ := emailChangeSvc(users)

		_, err := svc.RequestEmailChange(context.Background(), user.ID, "self@thc.local", raw, "Password123!")
		if err == nil {
			t.Fatalf("request to %q succeeded, want 400", raw)
		}
		if got := appErrorOf(t, err); got.Status != 400 || got.Code != "VALIDATION_ERROR" {
			t.Fatalf("error = %d/%s, want 400/VALIDATION_ERROR", got.Status, got.Code)
		}
		if len(tokens.mints) != 0 || len(mailer.Calls) != 0 {
			t.Fatalf("mints = %d, mails = %d, want zero side effects", len(tokens.mints), len(mailer.Calls))
		}
	}
}

// TestRequestEmailChange_OldEmailMismatchIs400 pins the stale-form guard: the
// supplied old address must equal the stored one.
func TestRequestEmailChange_OldEmailMismatchIs400(t *testing.T) {
	users, user := seedSelfUser(t, domain.RoleAdmin)
	svc, tokens, _, mailer, _ := emailChangeSvc(users)

	_, err := svc.RequestEmailChange(context.Background(), user.ID, "stale@thc.local", "baru@example.com", "Password123!")
	if err == nil {
		t.Fatal("request with stale old email succeeded, want 400")
	}
	if got := appErrorOf(t, err); got.Status != 400 || got.Code != "VALIDATION_ERROR" {
		t.Fatalf("error = %d/%s, want 400/VALIDATION_ERROR", got.Status, got.Code)
	}
	if len(tokens.mints) != 0 || len(mailer.Calls) != 0 {
		t.Fatalf("mints = %d, mails = %d, want zero side effects", len(tokens.mints), len(mailer.Calls))
	}
}

// TestRequestEmailChange_TakenNewEmailStillMints pins the request-side
// anti-oracle: whether the new address is taken must not show at request
// time, so the mint and the mail happen exactly like the free case. The taken
// address fails later at confirm with the generic link error.
func TestRequestEmailChange_TakenNewEmailStillMints(t *testing.T) {
	users, user := seedSelfUser(t, domain.RoleAdmin)
	taken := activeAdmin("unused")
	taken.ID = "user-other-1"
	taken.Email = "taken@thc.local"
	users.byEmail[taken.Email] = taken
	users.byID[taken.ID] = taken
	svc, tokens, _, mailer, _ := emailChangeSvc(users)

	token, err := svc.RequestEmailChange(context.Background(), user.ID, "self@thc.local", "taken@thc.local", "Password123!")
	if err != nil {
		t.Fatalf("request to a taken address must not reveal it: %v", err)
	}
	if token == "" {
		t.Fatal("empty token for the taken-address request")
	}
	if len(tokens.mints) != 1 || len(mailer.Calls) != 1 {
		t.Fatalf("mints = %d, mails = %d, want 1/1 like the free case", len(tokens.mints), len(mailer.Calls))
	}
}

// TestRequestEmailChange_NilMailerStillSucceeds pins fail-open delivery: an
// unwired mailer is logged, never a request failure, and the token still
// returns so the caller can deliver it.
func TestRequestEmailChange_NilMailerStillSucceeds(t *testing.T) {
	users, user := seedSelfUser(t, domain.RoleAdmin)
	svc, tokens, _, _, _ := emailChangeSvc(users)
	deps := loginDeps(users)
	deps.Profiles = &emailProfiles{users: users}
	deps.EmailTokens = tokens
	svc = NewService(deps)

	if _, err := svc.RequestEmailChange(context.Background(), user.ID, "self@thc.local", "baru@example.com", "Password123!"); err != nil {
		t.Fatalf("request without mailer: %v", err)
	}
}

// TestRequestEmailChange_MintFailureIs500 pins fail-closed wiring: the token
// service refusing to sign is a 500, never a link-flavoured error.
func TestRequestEmailChange_MintFailureIs500(t *testing.T) {
	users, user := seedSelfUser(t, domain.RoleAdmin)
	svc, tokens, _, mailer, _ := emailChangeSvc(users)
	tokens.mintErr = errors.New("HSM unreachable")

	_, err := svc.RequestEmailChange(context.Background(), user.ID, "self@thc.local", "baru@example.com", "Password123!")
	if err == nil {
		t.Fatal("request with broken minter succeeded, want 500")
	}
	if got := appErrorOf(t, err); got.Status != 500 || got.Code != "INTERNAL_ERROR" {
		t.Fatalf("error = %d/%s, want 500/INTERNAL_ERROR", got.Status, got.Code)
	}
	if len(mailer.Calls) != 0 {
		t.Fatalf("mailer calls = %d, want 0 without a token", len(mailer.Calls))
	}
}

// emailChangeRoundTrip requests a move to newEmail and returns the minted
// token for confirm-side tests.
func emailChangeRoundTrip(t *testing.T, svc *Service, user domain.User, newEmail string) string {
	t.Helper()
	token, err := svc.RequestEmailChange(context.Background(), user.ID, user.Email, newEmail, "Password123!")
	if err != nil {
		t.Fatalf("RequestEmailChange: %v", err)
	}
	return token
}

// TestConfirmEmailChange_HappyPathFlipsAndNotifies pins the confirm contract:
// the stored email flips exactly once, the audit trail names old/new with the
// self-email-change source, and BOTH notices queue (the old-address security
// copy verbatim plus the new-address success copy). Login follows the flip.
func TestConfirmEmailChange_HappyPathFlipsAndNotifies(t *testing.T) {
	users, user := seedSelfUser(t, domain.RoleAdmin)
	svc, _, profiles, mailer, audit := emailChangeSvc(users)
	token := emailChangeRoundTrip(t, svc, user, "baru@example.com")
	mailsAfterRequest := len(mailer.Calls)

	got, err := svc.ConfirmEmailChange(auditCtx(), user.ID, token)
	if err != nil {
		t.Fatalf("ConfirmEmailChange: %v", err)
	}
	if got.Email != "baru@example.com" {
		t.Fatalf("profile email = %q, want the flipped address", got.Email)
	}
	if profiles.calls != 1 {
		t.Fatalf("UpdateProfile calls = %d, want exactly 1", profiles.calls)
	}
	if profiles.lastUpdate.Email != "baru@example.com" {
		t.Fatalf("flipped email = %q, want baru@example.com", profiles.lastUpdate.Email)
	}
	if stored := users.byID[user.ID]; stored.Email != "baru@example.com" {
		t.Fatalf("stored email = %q, want baru@example.com", stored.Email)
	}
	if len(audit.entries) != 1 {
		t.Fatalf("audit entries = %d, want exactly 1", len(audit.entries))
	}
	entry := audit.entries[0]
	if entry.Action != domain.AuditActionUserUpdate || entry.Entity != domain.AuditEntityUser {
		t.Fatalf("trail = %q/%q, want user.update/user", entry.Action, entry.Entity)
	}
	if entry.ActorID == nil || *entry.ActorID != user.ID || entry.EntityID == nil || *entry.EntityID != user.ID {
		t.Fatalf("actor/subject = %v/%v, want the account id", entry.ActorID, entry.EntityID)
	}
	if entry.Metadata["source"] != "self-email-change" {
		t.Fatalf("source = %q, want self-email-change", entry.Metadata["source"])
	}
	if entry.Metadata["old_email"] != "self@thc.local" || entry.Metadata["new_email"] != "baru@example.com" {
		t.Fatalf("metadata = %v, want the old/new pair", entry.Metadata)
	}
	if entry.IP != "203.0.113.7" || entry.UserAgent != "AuditTest/1.0" {
		t.Fatalf("provenance = %+v, want the request meta", entry)
	}
	assertNoSecrets(t, audit.entries, "Password123!", token)
	if len(mailer.Calls) != mailsAfterRequest+2 {
		t.Fatalf("mailer calls = %d, want 2 confirm notices on top of %d", len(mailer.Calls), mailsAfterRequest)
	}
	oldNotice := mailer.Calls[mailsAfterRequest]
	if len(oldNotice.To) != 1 || oldNotice.To[0] != "self@thc.local" {
		t.Fatalf("old notice to = %v, want the OLD inbox", oldNotice.To)
	}
	wantOld := "Email akun THC-VMS Anda baru saja diganti menjadi baru@example.com. Jika ini bukan Anda, segera hubungi admin dan ganti kata sandi."
	if oldNotice.TextBody != wantOld {
		t.Fatalf("old notice = %q, want the verbatim security copy", oldNotice.TextBody)
	}
	newNotice := mailer.Calls[mailsAfterRequest+1]
	if len(newNotice.To) != 1 || newNotice.To[0] != "baru@example.com" {
		t.Fatalf("new notice to = %v, want the NEW inbox", newNotice.To)
	}
	if !strings.Contains(newNotice.TextBody, "baru@example.com") {
		t.Fatalf("new notice = %q, want the success copy naming the address", newNotice.TextBody)
	}
	if _, err := svc.Login(context.Background(), "baru@example.com", "Password123!"); err != nil {
		t.Fatalf("login with new email after confirm: %v", err)
	}
	if _, err := svc.Login(context.Background(), "self@thc.local", "Password123!"); err == nil {
		t.Fatal("login with old email succeeded after confirm, want failure")
	}
}

// TestConfirmEmailChange_ReplayAfterFlipIsGeneric pins single-use-by-binding:
// confirming the same token after the flip finds a mismatched old_email and
// fails with the generic link error, changing nothing.
func TestConfirmEmailChange_ReplayAfterFlipIsGeneric(t *testing.T) {
	users, user := seedSelfUser(t, domain.RoleAdmin)
	svc, _, profiles, mailer, audit := emailChangeSvc(users)
	token := emailChangeRoundTrip(t, svc, user, "baru@example.com")
	if _, err := svc.ConfirmEmailChange(context.Background(), user.ID, token); err != nil {
		t.Fatalf("first ConfirmEmailChange: %v", err)
	}
	mails, audits, writes := len(mailer.Calls), len(audit.entries), profiles.calls

	_, err := svc.ConfirmEmailChange(context.Background(), user.ID, token)
	if err == nil {
		t.Fatal("replay confirm succeeded, want the generic link error")
	}
	assertEmailLinkInvalid(t, err)
	if stored := users.byID[user.ID]; stored.Email != "baru@example.com" {
		t.Fatalf("stored email = %q, want the flipped address untouched", stored.Email)
	}
	if profiles.calls != writes || len(audit.entries) != audits || len(mailer.Calls) != mails {
		t.Fatalf("replay changed state: writes %d/%d, audits %d/%d, mails %d/%d",
			profiles.calls, writes, len(audit.entries), audits, len(mailer.Calls), mails)
	}
}

// TestConfirmEmailChange_UserMismatchIsGeneric pins the subject binding: a
// token minted for one account confirms for no other, with the generic link
// error and zero state change on both rows.
func TestConfirmEmailChange_UserMismatchIsGeneric(t *testing.T) {
	users, user := seedSelfUser(t, domain.RoleAdmin)
	other := activeAdmin("unused")
	other.ID = "user-other-1"
	other.Email = "other@thc.local"
	users.byEmail[other.Email] = other
	users.byID[other.ID] = other
	svc, _, profiles, mailer, audit := emailChangeSvc(users)
	token := emailChangeRoundTrip(t, svc, user, "baru@example.com")
	mails := len(mailer.Calls)

	_, err := svc.ConfirmEmailChange(context.Background(), other.ID, token)
	if err == nil {
		t.Fatal("cross-user confirm succeeded, want the generic link error")
	}
	assertEmailLinkInvalid(t, err)
	if stored := users.byID[user.ID]; stored.Email != "self@thc.local" {
		t.Fatalf("victim email = %q, want unchanged", stored.Email)
	}
	if stored := users.byID[other.ID]; stored.Email != "other@thc.local" {
		t.Fatalf("attacker email = %q, want unchanged", stored.Email)
	}
	if profiles.calls != 0 || len(audit.entries) != 0 || len(mailer.Calls) != mails {
		t.Fatalf("writes = %d, audits = %d, mails = %d/%d, want zero confirm effects",
			profiles.calls, len(audit.entries), len(mailer.Calls), mails)
	}
}

// TestConfirmEmailChange_OldEmailMismatchIsGeneric pins the stale-row binding:
// when the stored address no longer equals the token's old_email, the confirm
// fails generic with zero state change.
func TestConfirmEmailChange_OldEmailMismatchIsGeneric(t *testing.T) {
	users, user := seedSelfUser(t, domain.RoleAdmin)
	svc, _, profiles, mailer, audit := emailChangeSvc(users)
	token := emailChangeRoundTrip(t, svc, user, "baru@example.com")
	moved := users.byID[user.ID]
	moved.Email = "moved@thc.local"
	users.byID[user.ID] = moved
	mails := len(mailer.Calls)

	_, err := svc.ConfirmEmailChange(context.Background(), user.ID, token)
	if err == nil {
		t.Fatal("stale-row confirm succeeded, want the generic link error")
	}
	assertEmailLinkInvalid(t, err)
	if profiles.calls != 0 || len(audit.entries) != 0 || len(mailer.Calls) != mails {
		t.Fatalf("writes = %d, audits = %d, mails = %d/%d, want zero confirm effects",
			profiles.calls, len(audit.entries), len(mailer.Calls), mails)
	}
}

// TestConfirmEmailChange_UnknownAndExpiredTokensAreGeneric pins the tamper and
// expiry paths: every unverifiable token renders the identical generic error.
func TestConfirmEmailChange_UnknownAndExpiredTokensAreGeneric(t *testing.T) {
	users, user := seedSelfUser(t, domain.RoleVendor)
	svc, tokens, _, _, _ := emailChangeSvc(users)
	tokens.verifyErr = fmt.Errorf("fake token expired: %w", domain.ErrUnauthorized)

	for _, token := range []string{"bogus-token", "email-token-999"} {
		_, err := svc.ConfirmEmailChange(context.Background(), user.ID, token)
		if err == nil {
			t.Fatalf("confirm of %q succeeded, want the generic link error", token)
		}
		assertEmailLinkInvalid(t, err)
	}
	if stored := users.byID[user.ID]; stored.Email != "self@thc.local" {
		t.Fatalf("stored email = %q, want unchanged", stored.Email)
	}
}

// TestConfirmEmailChange_TakenNewEmailIsGeneric pins the confirm-side
// anti-oracle: a new address taken after minting fails with the byte-identical
// generic link error (indistinguishable from an expired token), the flip never
// happens, and nothing is mailed or audited.
func TestConfirmEmailChange_TakenNewEmailIsGeneric(t *testing.T) {
	users, user := seedSelfUser(t, domain.RoleAdmin)
	taken := activeAdmin("unused")
	taken.ID = "user-other-1"
	taken.Email = "taken@thc.local"
	users.byEmail[taken.Email] = taken
	users.byID[taken.ID] = taken
	svc, _, profiles, mailer, audit := emailChangeSvc(users)
	token := emailChangeRoundTrip(t, svc, user, "taken@thc.local")
	mails := len(mailer.Calls)

	_, takenErr := svc.ConfirmEmailChange(context.Background(), user.ID, token)
	if takenErr == nil {
		t.Fatal("confirm onto a taken address succeeded, want the generic link error")
	}
	assertEmailLinkInvalid(t, takenErr)
	_, unknownErr := svc.ConfirmEmailChange(context.Background(), user.ID, "bogus-token")
	if unknownErr == nil {
		t.Fatal("confirm of a bogus token succeeded, want the generic link error")
	}
	if appErrorOf(t, takenErr).Code != appErrorOf(t, unknownErr).Code ||
		appErrorOf(t, takenErr).Message != appErrorOf(t, unknownErr).Message {
		t.Fatalf("taken (%v) differs from unknown (%v), want byte-identical", takenErr, unknownErr)
	}
	if stored := users.byID[user.ID]; stored.Email != "self@thc.local" {
		t.Fatalf("stored email = %q, want unchanged", stored.Email)
	}
	if profiles.calls != 0 || len(audit.entries) != 0 || len(mailer.Calls) != mails {
		t.Fatalf("writes = %d, audits = %d, mails = %d/%d, want zero confirm effects",
			profiles.calls, len(audit.entries), len(mailer.Calls), mails)
	}
}

// TestConfirmEmailChange_RacedConflictIsGeneric pins the last-line oracle
// guard: a uniqueness clash surfacing from the write itself (a row raced in
// after the freeness check) still renders the generic link error.
func TestConfirmEmailChange_RacedConflictIsGeneric(t *testing.T) {
	users, user := seedSelfUser(t, domain.RoleAdmin)
	svc, _, profiles, _, _ := emailChangeSvc(users)
	token := emailChangeRoundTrip(t, svc, user, "baru@example.com")
	profiles.err = domain.ErrConflict

	_, err := svc.ConfirmEmailChange(context.Background(), user.ID, token)
	if err == nil {
		t.Fatal("confirm with raced conflict succeeded, want the generic link error")
	}
	assertEmailLinkInvalid(t, err)
}

// TestConfirmEmailChange_BestEffortOutagesStillSucceed pins the delivery
// guarantee: a dead audit trail and a dead mailer are logged, never a confirm
// failure — the flip still lands.
func TestConfirmEmailChange_BestEffortOutagesStillSucceed(t *testing.T) {
	users, user := seedSelfUser(t, domain.RoleAdmin)
	svc, _, profiles, mailer, audit := emailChangeSvc(users)
	token := emailChangeRoundTrip(t, svc, user, "baru@example.com")
	audit.appendErr = errors.New("trail unavailable")
	mailer.Err = errors.New("SMTP unreachable")

	got, err := svc.ConfirmEmailChange(context.Background(), user.ID, token)
	if err != nil {
		t.Fatalf("confirm must succeed despite dead audit/mailer: %v", err)
	}
	if got.Email != "baru@example.com" || profiles.calls != 1 {
		t.Fatalf("flip missing: email = %q, writes = %d", got.Email, profiles.calls)
	}
	if stored := users.byID[user.ID]; stored.Email != "baru@example.com" {
		t.Fatalf("stored email = %q, want baru@example.com", stored.Email)
	}
}
