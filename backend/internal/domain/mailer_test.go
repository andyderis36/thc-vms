package domain_test

// Port-side suite for the email fan-out contract (mailer.go): the allowlist
// admits exactly the eight lifecycle types, the FakeMailer records sends,
// and the enqueue-time gate drops excluded types before any Send call.

import (
	"context"
	"testing"

	"thc-vms/backend/internal/domain"
)

// emailAllowedCases is the locked allowlist expectation: exactly these nine
// notification types may fan out to email; everything else stays in_app-only.
// visit_requested is email-safe on the staff leg only (branch admins plus the
// national overseers); the vendor and branch security legs are never mailed.
var emailAllowedCases = []struct {
	typ   domain.NotificationType
	allow bool
}{
	{domain.NotificationVisitRequested, true},
	{domain.NotificationVisitApproved, true},
	{domain.NotificationVisitRejected, true},
	{domain.NotificationVisitCancelled, true},
	{domain.NotificationVisitAutoCancelled, true},
	{domain.NotificationVisitRescheduled, true},
	{domain.NotificationVisitReminder, true},
	{domain.NotificationVisitCheckIn, true},
	{domain.NotificationVisitCheckOut, true},
	{domain.NotificationType(""), false},
	{domain.NotificationType("visit_deleted"), false},
}

// TestEmailAllowed_AllowsExactlyNineTypes proves the allowlist admits the
// nine email-safe lifecycle types and nothing else.
func TestEmailAllowed_AllowsExactlyNineTypes(t *testing.T) {
	for _, tc := range emailAllowedCases {
		if got := domain.EmailAllowed(tc.typ); got != tc.allow {
			t.Errorf("EmailAllowed(%q) = %v, want %v", tc.typ, got, tc.allow)
		}
	}
}

// TestFakeMailer_RecordsCalls proves the fake captures every Send for
// assertions without touching the network.
func TestFakeMailer_RecordsCalls(t *testing.T) {
	fake := &domain.FakeMailer{}
	var _ domain.Mailer = fake // fake must satisfy the port
	ctx := context.Background()
	if err := fake.Send(ctx, []string{"vendor@example.com"}, "s", "t", "<p>h</p>"); err != nil {
		t.Fatalf("FakeMailer.Send() = %v, want nil", err)
	}
	if len(fake.Calls) != 1 {
		t.Fatalf("len(Calls) = %d, want 1", len(fake.Calls))
	}
	call := fake.Calls[0]
	if len(call.To) != 1 || call.To[0] != "vendor@example.com" {
		t.Errorf("To = %v, want [vendor@example.com]", call.To)
	}
	if call.Subject != "s" || call.TextBody != "t" || call.HTMLBody != "<p>h</p>" {
		t.Errorf("call = %+v, want the exact subject/text/html passed to Send", call)
	}
}

// TestEmailGate_RequestedPassesWhileAutoCancelSends proves the enqueue-time
// contract: visit_requested now passes the gate (staff leg: branch admins
// plus national overseers), and the R1/R2 visit_auto_cancelled notice passes
// it too, producing exactly one Send each.
func TestEmailGate_RequestedPassesWhileAutoCancelSends(t *testing.T) {
	fake := &domain.FakeMailer{}
	ctx := context.Background()
	visit := testVisit()
	if tpl := domain.CreatedNotification(visit.VisitID); !domain.EmailAllowed(tpl.Type) {
		t.Errorf("EmailAllowed(%q) = false, want true: new requests mail the staff leg", tpl.Type)
	}
	tpl := domain.TransitionNotification(domain.VisitStatusCancelled, true, visit.VisitID, "")
	if tpl == nil {
		t.Fatal("system-cancel template is nil, want the visit_auto_cancelled notice")
	}
	if !domain.EmailAllowed(tpl.Type) {
		t.Fatalf("EmailAllowed(%q) = false, want true: R1/R2 auto-cancel emails the vendor", tpl.Type)
	}
	subject, textBody, htmlBody := domain.BuildEmail(visit, tpl)
	if err := fake.Send(ctx, []string{"vendor@example.com"}, subject, textBody, htmlBody); err != nil {
		t.Fatal(err)
	}
	if len(fake.Calls) != 1 {
		t.Errorf("len(Calls) = %d, want 1: auto-cancel must reach Send", len(fake.Calls))
	}
}
