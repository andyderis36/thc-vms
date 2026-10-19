package auth

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
)

// fakeAudit is a hand-written fake for domain.AuditRepository: it records
// every appended entry and replays a canned List, with an injectable Append
// error to prove audit failures never fail the request.
type fakeAudit struct {
	entries   []domain.AuditEntry
	appendErr error
}

func (f *fakeAudit) Append(_ context.Context, entry domain.AuditEntry) (domain.AuditLog, error) {
	if f.appendErr != nil {
		return domain.AuditLog{}, f.appendErr
	}
	f.entries = append(f.entries, entry)
	return domain.AuditLog{Action: entry.Action, Entity: entry.Entity}, nil
}

func (f *fakeAudit) List(_ context.Context, _ domain.AuditFilter) ([]domain.AuditLog, int64, error) {
	return nil, int64(len(f.entries)), nil
}

func auditCtx() context.Context {
	return domain.ContextWithRequestMeta(context.Background(),
		domain.RequestMetaFor("203.0.113.7", "AuditTest/1.0"))
}

func loginSvcWithAudit(users *fakeUsers, audit *fakeAudit) *Service {
	deps := loginDeps(users)
	deps.Audit = audit
	return NewService(deps)
}

func seedAdminUser(t *testing.T, password string) *fakeUsers {
	t.Helper()
	users := &fakeUsers{byEmail: map[string]domain.User{}, byID: map[domain.UUID]domain.User{}}
	admin := activeAdmin(hashPassword(t, password))
	users.byEmail[admin.Email] = admin
	users.byID[admin.ID] = admin
	return users
}

func assertNoSecrets(t *testing.T, entries []domain.AuditEntry, secrets ...string) {
	t.Helper()
	for _, entry := range entries {
		for key, value := range entry.Metadata {
			lowered := strings.ToLower(key)
			for _, banned := range []string{"password", "token", "secret", "hash"} {
				if strings.Contains(lowered, banned) {
					t.Fatalf("audit metadata carries secret key %q", key)
				}
			}
			for _, secret := range secrets {
				if secret != "" && strings.Contains(value, secret) {
					t.Fatalf("audit metadata leaks a secret value in key %q", key)
				}
			}
		}
		if entry.Action == "" || entry.Entity == "" {
			t.Fatalf("audit entry must name action and entity: %+v", entry)
		}
	}
}

func TestLoginAudit_SuccessRecordsTrailWithoutSecrets(t *testing.T) {
	users := seedAdminUser(t, "Password123!")
	audit := &fakeAudit{}
	svc := loginSvcWithAudit(users, audit)

	got, err := svc.Login(auditCtx(), "admin@thc.local", "Password123!")
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	if got.Token == "" {
		t.Fatal("empty token despite successful login")
	}
	if len(audit.entries) != 1 {
		t.Fatalf("audit entries = %d, want exactly 1", len(audit.entries))
	}
	entry := audit.entries[0]
	if entry.Action != domain.AuditActionLoginSuccess {
		t.Fatalf("action = %q, want %q", entry.Action, domain.AuditActionLoginSuccess)
	}
	if entry.ActorID == nil || *entry.ActorID != "user-admin-1" {
		t.Fatalf("actor = %v, want the authenticated account", entry.ActorID)
	}
	if entry.EntityID == nil || *entry.EntityID != "user-admin-1" {
		t.Fatalf("subject = %v, want the authenticated account", entry.EntityID)
	}
	if entry.IP != "203.0.113.7" || entry.UserAgent != "AuditTest/1.0" {
		t.Fatalf("provenance = %+v, want the request meta", entry)
	}
	if entry.Metadata["email"] != "admin@thc.local" {
		t.Fatalf("metadata = %v, want the normalised email", entry.Metadata)
	}
	assertNoSecrets(t, audit.entries, "Password123!")
}

func TestLoginAudit_FailedRecordsTrailWithoutSecrets(t *testing.T) {
	users := seedAdminUser(t, "Password123!")
	audit := &fakeAudit{}
	svc := loginSvcWithAudit(users, audit)

	for _, email := range []string{"admin@thc.local", "ghost@thc.local"} {
		if _, err := svc.Login(auditCtx(), email, "WrongPassword!"); err == nil {
			t.Fatalf("login as %s with wrong password must fail", email)
		}
	}
	if len(audit.entries) != 2 {
		t.Fatalf("audit entries = %d, want 2 failed rows", len(audit.entries))
	}
	for _, entry := range audit.entries {
		if entry.Action != domain.AuditActionLoginFailed {
			t.Fatalf("action = %q, want %q", entry.Action, domain.AuditActionLoginFailed)
		}
		if entry.ActorID != nil || entry.EntityID != nil {
			t.Fatalf("failed login must carry no actor/subject: %+v", entry)
		}
	}
	if audit.entries[0].Metadata["email"] != "admin@thc.local" {
		t.Fatalf("wrong-password metadata = %v", audit.entries[0].Metadata)
	}
	if audit.entries[1].Metadata["email"] != "ghost@thc.local" {
		t.Fatalf("unknown-email metadata = %v", audit.entries[1].Metadata)
	}
	if audit.entries[0].Metadata["reason"] != audit.entries[1].Metadata["reason"] {
		t.Fatal("wrong-password and unknown-email reasons must match (no account oracle)")
	}
	assertNoSecrets(t, audit.entries, "WrongPassword!", "Password123!")
}

func TestLoginAudit_InactiveAccountRecordsFailedWithoutSecrets(t *testing.T) {
	users := &fakeUsers{byEmail: map[string]domain.User{}, byID: map[domain.UUID]domain.User{}}
	inactive := activeAdmin(hashPassword(t, "Password123!"))
	inactive.ID = "user-inactive-1"
	inactive.Email = "inactive@thc.local"
	inactive.Status = domain.UserStatusInactive
	users.byEmail[inactive.Email] = inactive
	users.byID[inactive.ID] = inactive
	audit := &fakeAudit{}
	svc := loginSvcWithAudit(users, audit)

	if _, err := svc.Login(auditCtx(), "inactive@thc.local", "Password123!"); err == nil {
		t.Fatal("inactive login must fail")
	}
	if len(audit.entries) != 1 || audit.entries[0].Action != domain.AuditActionLoginFailed {
		t.Fatalf("entries = %+v, want one failed row", audit.entries)
	}
	assertNoSecrets(t, audit.entries, "Password123!")
}

func TestLoginAudit_TrailFailureNeverFailsLogin(t *testing.T) {
	users := seedAdminUser(t, "Password123!")
	audit := &fakeAudit{appendErr: errors.New("trail unavailable")}
	svc := loginSvcWithAudit(users, audit)

	got, err := svc.Login(auditCtx(), "admin@thc.local", "Password123!")
	if err != nil {
		t.Fatalf("login must succeed despite audit failure: %v", err)
	}
	if got.Token == "" {
		t.Fatal("empty token despite successful login")
	}
	if _, err := svc.Login(auditCtx(), "admin@thc.local", "Wrong!"); err == nil {
		t.Fatal("wrong password must still fail when the trail is down")
	}
}

func TestLoginAudit_NilWriterDisablesTrail(t *testing.T) {
	users := seedAdminUser(t, "Password123!")
	svc := NewService(loginDeps(users))

	if _, err := svc.Login(context.Background(), "admin@thc.local", "Password123!"); err != nil {
		t.Fatalf("login without audit writer: %v", err)
	}
	if _, err := svc.Login(context.Background(), "admin@thc.local", "Wrong!"); err == nil {
		t.Fatal("wrong password must fail without audit writer")
	}
}

func TestLoginAudit_LastLoginStillStamped(t *testing.T) {
	users := seedAdminUser(t, "Password123!")
	audit := &fakeAudit{}
	svc := loginSvcWithAudit(users, audit)

	before := time.Now()
	if _, err := svc.Login(auditCtx(), "admin@thc.local", "Password123!"); err != nil {
		t.Fatalf("Login: %v", err)
	}
	stamped, ok := users.lastLoginAt["user-admin-1"]
	if !ok {
		t.Fatal("successful login must still stamp last login with the trail on")
	}
	if stamped.Before(before) {
		t.Fatalf("last login %v predates the call %v", stamped, before)
	}
}
