package handlers_test

import (
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/handlers"
	"thc-vms/backend/internal/domain"
)

// newOverrideEngine wires the PATCH /users/:id surface with BOTH the trail
// and the mailer attached, so the admin-override email path is pinned
// end to end (audit entry + dual notices).
func newOverrideEngine(users *stubManagedUsers, mailer domain.Mailer, audit *fakeAuditRepo) *gin.Engine {
	engine := gin.New()
	engine.Use(withActor(domain.RoleSuperAdmin, ""))
	h := handlers.NewSuperAdminHandler(users, newStubLocationAdmin(), newStubLocationAdmin(), newStubVisitRepos(), "role-admin", "role-vendor").
		WithAudit(audit).
		WithMailer(mailer)
	engine.PATCH("/users/:id", h.UpdateUser)
	return engine
}

// TestSuperAdmin_EmailOverrideDualNotifyAndAudit pins the hardened
// PATCH /users/:id email-override path: a real address change appends one
// user.update row carrying source:admin-override + the old/new pair + the
// acting super_admin, and queues BOTH best-effort notices (the verbatim
// security copy to the OLD inbox, the success copy to the NEW one).
func TestSuperAdmin_EmailOverrideDualNotifyAndAudit(t *testing.T) {
	users := newStubManagedUsers(managedAccount("target-1", "lama@thc.local", domain.RoleAdmin, nil))
	mailer := &domain.FakeMailer{}
	audit := &fakeAuditRepo{}
	engine := newOverrideEngine(users, mailer, audit)

	rec := serveJSON(engine, "PATCH", "/users/target-1", `{"email":"baru@thc.local"}`)
	mustStatus(t, rec, http.StatusOK)

	if len(audit.entries) != 1 {
		t.Fatalf("audit entries = %d, want exactly 1 user.update row", len(audit.entries))
	}
	entry := audit.entries[0]
	if entry.Action != domain.AuditActionUserUpdate || entry.Entity != domain.AuditEntityUser {
		t.Fatalf("trail = %q/%q, want user.update/user", entry.Action, entry.Entity)
	}
	if entry.ActorID == nil || *entry.ActorID != "actor-1" {
		t.Fatalf("actor = %v, want the calling super_admin", entry.ActorID)
	}
	if entry.EntityID == nil || *entry.EntityID != "target-1" {
		t.Fatalf("subject = %v, want target-1", entry.EntityID)
	}
	if entry.Metadata["source"] != "admin-override" {
		t.Fatalf("source = %q, want admin-override", entry.Metadata["source"])
	}
	if entry.Metadata["old_email"] != "lama@thc.local" || entry.Metadata["new_email"] != "baru@thc.local" {
		t.Fatalf("metadata = %v, want the old/new email pair", entry.Metadata)
	}

	if len(mailer.Calls) != 2 {
		t.Fatalf("mailer calls = %d, want exactly 2 override notices", len(mailer.Calls))
	}
	oldNotice := mailer.Calls[0]
	if len(oldNotice.To) != 1 || oldNotice.To[0] != "lama@thc.local" {
		t.Fatalf("old notice to = %v, want the OLD inbox only", oldNotice.To)
	}
	wantOld := "Email akun THC-VMS Anda baru saja diganti menjadi baru@thc.local. Jika ini bukan Anda, segera hubungi admin dan ganti kata sandi."
	if oldNotice.TextBody != wantOld {
		t.Fatalf("old notice = %q, want the verbatim security copy", oldNotice.TextBody)
	}
	newNotice := mailer.Calls[1]
	if len(newNotice.To) != 1 || newNotice.To[0] != "baru@thc.local" {
		t.Fatalf("new notice to = %v, want the NEW inbox only", newNotice.To)
	}
	if !strings.Contains(newNotice.TextBody, "baru@thc.local") {
		t.Fatalf("new notice = %q, want the success copy naming the address", newNotice.TextBody)
	}
}

// TestSuperAdmin_EmailOverrideNonEmailUpdateSendsNothing pins the unchanged
// guard: a PATCH that leaves the address alone (name-only, or the same
// address re-sent) queues zero mails and carries no override source key.
func TestSuperAdmin_EmailOverrideNonEmailUpdateSendsNothing(t *testing.T) {
	t.Run("name-only patch", func(t *testing.T) {
		users := newStubManagedUsers(managedAccount("target-1", "lama@thc.local", domain.RoleAdmin, nil))
		mailer := &domain.FakeMailer{}
		audit := &fakeAuditRepo{}
		engine := newOverrideEngine(users, mailer, audit)

		mustStatus(t, serveJSON(engine, "PATCH", "/users/target-1", `{"name":"Baru"}`), http.StatusOK)
		if len(mailer.Calls) != 0 {
			t.Fatalf("mailer calls = %d, want 0 for a non-email update", len(mailer.Calls))
		}
		if len(audit.entries) != 1 {
			t.Fatalf("audit entries = %d, want the single user.update row", len(audit.entries))
		}
		if src := audit.entries[0].Metadata["source"]; src != "" {
			t.Fatalf("source = %q, want absent without an email change", src)
		}
	})

	t.Run("same address re-sent", func(t *testing.T) {
		users := newStubManagedUsers(managedAccount("target-1", "lama@thc.local", domain.RoleAdmin, nil))
		mailer := &domain.FakeMailer{}
		audit := &fakeAuditRepo{}
		engine := newOverrideEngine(users, mailer, audit)

		mustStatus(t, serveJSON(engine, "PATCH", "/users/target-1", `{"email":" LAMA@thc.local "}`), http.StatusOK)
		if len(mailer.Calls) != 0 {
			t.Fatalf("mailer calls = %d, want 0 for an unchanged address", len(mailer.Calls))
		}
	})
}

// TestSuperAdmin_EmailOverridePeerSuperAdminRefused pins the peer-update
// guard: PATCHing ANOTHER super_admin (or dev-superadmin) row — email or any
// other field — is 403 FORBIDDEN with zero side effects (no mails, no trail
// row, stored row untouched), mirroring the status/delete/password siblings.
func TestSuperAdmin_EmailOverridePeerSuperAdminRefused(t *testing.T) {
	for _, tc := range []struct {
		name string
		role domain.RoleName
		body string
	}{
		{"peer superadmin email", domain.RoleSuperAdmin, `{"email":"bajak@thc.local"}`},
		{"peer dev-superadmin email", domain.RoleDevSuperAdmin, `{"email":"bajak@thc.local"}`},
		{"peer superadmin non-email field", domain.RoleSuperAdmin, `{"name":"Bajak"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			users := newStubManagedUsers(managedAccount("pusat-9", "pusat@thc.local", tc.role, nil))
			mailer := &domain.FakeMailer{}
			audit := &fakeAuditRepo{}
			engine := newOverrideEngine(users, mailer, audit)

			rec := serveJSON(engine, "PATCH", "/users/pusat-9", tc.body)
			mustStatus(t, rec, http.StatusForbidden)
			if env := decodeEnvelope(t, rec); env.Error == nil || env.Error.Code != "FORBIDDEN" {
				t.Fatalf("peer superadmin update must be 403 FORBIDDEN, got %q", rec.Body.String())
			}
			if len(mailer.Calls) != 0 {
				t.Fatalf("mailer calls = %d, want 0 for a refused peer update", len(mailer.Calls))
			}
			if len(audit.entries) != 0 {
				t.Fatalf("audit entries = %d, want 0 for a refused peer update", len(audit.entries))
			}
			if got := users.byID["pusat-9"].User.Email; got != "pusat@thc.local" {
				t.Fatalf("peer email = %q, want untouched pusat@thc.local", got)
			}
			if got := users.byID["pusat-9"].User.Name; got != "Akun pusat-9" {
				t.Fatalf("peer name = %q, want untouched", got)
			}
		})
	}
}

// TestSuperAdmin_EmailOverrideSelfEditStillAllowed pins that the peer guard
// only refuses OTHER super_admin rows: editing your own super_admin account
// keeps the full override behavior (200 + override trail + dual notices).
func TestSuperAdmin_EmailOverrideSelfEditStillAllowed(t *testing.T) {
	users := newStubManagedUsers(managedAccount("actor-1", "saya@thc.local", domain.RoleSuperAdmin, nil))
	mailer := &domain.FakeMailer{}
	audit := &fakeAuditRepo{}
	engine := newOverrideEngine(users, mailer, audit)

	rec := serveJSON(engine, "PATCH", "/users/actor-1", `{"email":"baru-saya@thc.local"}`)
	mustStatus(t, rec, http.StatusOK)

	if len(audit.entries) != 1 {
		t.Fatalf("audit entries = %d, want exactly 1 user.update row", len(audit.entries))
	}
	if audit.entries[0].Metadata["source"] != "admin-override" {
		t.Fatalf("source = %q, want admin-override for a self email change", audit.entries[0].Metadata["source"])
	}
	if len(mailer.Calls) != 2 {
		t.Fatalf("mailer calls = %d, want exactly 2 override notices", len(mailer.Calls))
	}
	if got := users.byID["actor-1"].User.Email; got != "baru-saya@thc.local" {
		t.Fatalf("self email = %q, want baru-saya@thc.local", got)
	}
}
func TestSuperAdmin_EmailOverrideTakenIs409(t *testing.T) {
	users := newStubManagedUsers(managedAccount("target-1", "lama@thc.local", domain.RoleAdmin, nil))
	users.updateUserErr = fmt.Errorf("repository: uniqueness clash: %w", domain.ErrConflict)
	mailer := &domain.FakeMailer{}
	audit := &fakeAuditRepo{}
	engine := newOverrideEngine(users, mailer, audit)

	rec := serveJSON(engine, "PATCH", "/users/target-1", `{"email":"kembar@thc.local"}`)
	mustStatus(t, rec, http.StatusConflict)
	if env := decodeEnvelope(t, rec); env.Error == nil || env.Error.Code != "CONFLICT" {
		t.Fatalf("duplicate override email must be 409 CONFLICT, got %q", rec.Body.String())
	}
	if len(mailer.Calls) != 0 {
		t.Fatalf("mailer calls = %d, want 0 for a refused override", len(mailer.Calls))
	}
	if len(audit.entries) != 0 {
		t.Fatalf("audit entries = %d, want 0 for a refused override", len(audit.entries))
	}
}
