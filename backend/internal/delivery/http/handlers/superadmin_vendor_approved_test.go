package handlers_test

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/handlers"
	"thc-vms/backend/internal/domain"
)

// fakeStatusResolver satisfies the handler's queue-drain port without importing
// the auth usecase: it records the approved flag per resolve and counts the
// idempotent TO-pending re-queues.
type fakeStatusResolver struct {
	calls        int
	approved     []bool
	ensureCalls  int
	ensureErr    error
	err          error
}

func (f *fakeStatusResolver) ResolveVendorRegistration(_ context.Context, _ domain.UUID, approved bool) error {
	f.calls++
	f.approved = append(f.approved, approved)
	return f.err
}

func (f *fakeStatusResolver) EnsureVendorRegistrationNotice(_ context.Context, _ domain.UUID) error {
	f.ensureCalls++
	return f.ensureErr
}

func newStatusEngine(users *stubManagedUsers, mailer domain.Mailer, resolver *fakeStatusResolver) *gin.Engine {
	engine := gin.New()
	engine.Use(withActor(domain.RoleSuperAdmin, ""))
	h := handlers.NewSuperAdminHandler(users, newStubLocationAdmin(), newStubLocationAdmin(), newStubVisitRepos(), "role-admin", "role-vendor").
		WithMailer(mailer).
		WithRegistrationResolver(resolver)
	engine.PATCH("/users/:id/status", h.UpdateUserStatus)
	return engine
}

// TestSuperAdmin_VendorApproveSendsApprovedMail is the S2(b) RED pin: flipping
// a pending vendor to active must mail the vendor inbox (terverifikasi + login
// CTA copy) while the 200 still stands. Inactive/reject must send nothing.
func TestSuperAdmin_VendorApproveSendsApprovedMail(t *testing.T) {
	target := managedAccount("vendor-9", "vendor9@vendor.example", domain.RoleVendor, nil)
	target.User.Status = domain.UserStatusPending
	users := newStubManagedUsers(target)
	mailer := &domain.FakeMailer{}
	resolver := &fakeStatusResolver{}
	engine := newStatusEngine(users, mailer, resolver)

	mustStatus(t, serveJSON(engine, "PATCH", "/users/vendor-9/status", `{"status":"active"}`), http.StatusOK)

	if resolver.calls != 1 || len(resolver.approved) != 1 || !resolver.approved[0] {
		t.Fatalf("resolver calls = %d approved = %v, want exactly one approved resolve", resolver.calls, resolver.approved)
	}
	if len(mailer.Calls) != 1 {
		t.Fatalf("mailer calls = %d, want exactly 1 approved notice", len(mailer.Calls))
	}
	call := mailer.Calls[0]
	if len(call.To) != 1 || !strings.EqualFold(call.To[0], "vendor9@vendor.example") {
		t.Fatalf("approved notice to = %v, want the vendor inbox only", call.To)
	}
	lower := strings.ToLower(call.TextBody + " " + call.Subject)
	if !strings.Contains(lower, "terverifikasi") || !strings.Contains(lower, "masuk") {
		t.Fatalf("approved copy = %q / %q, want terverifikasi + masuk/login wording", call.Subject, call.TextBody)
	}
	if !strings.Contains(call.HTMLBody, "/login") {
		t.Fatalf("approved html must carry the /login CTA, got %q", call.HTMLBody)
	}
}

// TestSuperAdmin_VendorRejectSendsNoMail pins the negative leg: inactive sends
// zero vendor mails (resolve still drains with approved=false).
func TestSuperAdmin_VendorRejectSendsNoMail(t *testing.T) {
	target := managedAccount("vendor-7", "vendor7@vendor.example", domain.RoleVendor, nil)
	target.User.Status = domain.UserStatusPending
	users := newStubManagedUsers(target)
	mailer := &domain.FakeMailer{}
	resolver := &fakeStatusResolver{}
	engine := newStatusEngine(users, mailer, resolver)

	mustStatus(t, serveJSON(engine, "PATCH", "/users/vendor-7/status", `{"status":"inactive"}`), http.StatusOK)

	if resolver.calls != 1 || len(resolver.approved) != 1 || resolver.approved[0] {
		t.Fatalf("resolver calls = %d approved = %v, want exactly one rejected resolve", resolver.calls, resolver.approved)
	}
	if len(mailer.Calls) != 0 {
		t.Fatalf("mailer calls = %d, want 0 on reject/inactive", len(mailer.Calls))
	}
}

// TestSuperAdmin_VendorApproveMailerFailureStill200 pins best-effort: a dying
// mailer never fails the status flip.
func TestSuperAdmin_VendorApproveMailerFailureStill200(t *testing.T) {
	target := managedAccount("vendor-8", "vendor8@vendor.example", domain.RoleVendor, nil)
	target.User.Status = domain.UserStatusPending
	users := newStubManagedUsers(target)
	mailer := &domain.FakeMailer{Err: errors.New("smtp down")}
	resolver := &fakeStatusResolver{}
	engine := newStatusEngine(users, mailer, resolver)

	mustStatus(t, serveJSON(engine, "PATCH", "/users/vendor-8/status", `{"status":"active"}`), http.StatusOK)
}
