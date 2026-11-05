package handlers_test

import (
	"net/http"
	"testing"

	"thc-vms/backend/internal/domain"
)

// TestSuperAdmin_StatusToPendingQueuesNotice is the S1 regression pin:
// flipping any vendor account TO pending must (re)queue exactly one
// idempotent vendor-registration notice row, otherwise users.status=pending
// exists with no matching notice row and the superadmin approval bell
// (GET /notifications/pending-registrations, limit 1/5) stays empty for an
// account that needs a decision. The flip itself stays 200 best-effort.
func TestSuperAdmin_StatusToPendingQueuesNotice(t *testing.T) {
	target := managedAccount("vendor-6", "vendor6@vendor.example", domain.RoleVendor, nil)
	target.User.Status = domain.UserStatusActive
	users := newStubManagedUsers(target)
	mailer := &domain.FakeMailer{}
	resolver := &fakeStatusResolver{}
	engine := newStatusEngine(users, mailer, resolver)

	mustStatus(t, serveJSON(engine, "PATCH", "/users/vendor-6/status", `{"status":"pending"}`), http.StatusOK)

	if resolver.ensureCalls != 1 {
		t.Fatalf("pending-queue inserts = %d, want exactly 1 (users.status=pending without a notice row leaves the bell empty)", resolver.ensureCalls)
	}
	if len(mailer.Calls) != 0 {
		t.Fatalf("mailer calls = %d, want 0 on flip-to-pending (no vendor mail on this leg)", len(mailer.Calls))
	}
}
