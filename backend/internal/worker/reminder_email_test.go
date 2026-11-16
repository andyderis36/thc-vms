package worker_test

// Reminder email fan-out suite (async, after-commit of the in_app write):
// an R4 reminder enqueues exactly one vendor email; a nil mailer, an empty
// recipient set or a mailer failure never fails the sweep. The mailer is
// always the domain FakeMailer: no test here dials SMTP.

import (
	"errors"
	"strings"
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/worker"
)

// errTestSMTPDown is the canned mailer failure: the sweep must stay green.
var errTestSMTPDown = errors.New("smtp 421 downstream temporarily unavailable (test)")

// containsCode reports whether s carries the visit code.
func containsCode(s, code string) bool { return strings.Contains(s, code) }

func workerServiceWithMailer(
	visits *fakeVisitRepo,
	rules *fakeAutoRules,
	checks *fakeCheckInOutRepo,
	notifications *fakeNotificationRepo,
	mailer domain.Mailer,
) *worker.Service {
	return worker.NewService(worker.Dependencies{
		Visits:        visits,
		Rules:         rules,
		CheckIns:      checks,
		Notifications: notifications,
		Mailer:        mailer,
		Clock:         &stubClock{now: workerNow},
	})
}

// reminderVisit stages an approved visit starting 30m from the frozen now,
// inside the production ReminderWindow.
func reminderVisit(id domain.UUID) domain.VisitRequest {
	return mkVisit(id, domain.VisitStatusApproved,
		workerNow.Add(-time.Hour), workerNow.Add(30*time.Minute), workerNow.Add(2*time.Hour))
}

// TestReminder_EnqueuesVendorPlusStaffEmails proves an in-window reminder
// enqueues one email to the resolved vendor address plus one staff send with
// the branch direct owners in To and the national overseers in Bcc.
func TestReminder_EnqueuesVendorPlusStaffEmails(t *testing.T) {
	t.Parallel()
	// Given: an approved in-window visit and resolvers returning both legs.
	v := reminderVisit("visit-r4mail")
	visits := newFakeVisitRepo(v)
	rules := &fakeAutoRules{reminders: []domain.VisitRequest{v}}
	notif := &fakeNotificationRepo{
		recipients: []string{"vendor-r4@example.com"},
		staffTo:      []string{"admin-r4@thc.test", "security-r4@thc.test"},
		staffBcc:     []string{"super-r4@thc.test"},
	}
	fake := &domain.FakeMailer{}
	svc := workerServiceWithMailer(visits, rules, newFakeCheckInOutRepo(), notif, fake)
	// When: the sweep runs.
	summary := svc.Run(t.Context())
	// Then: one reminder counted, two in_app rows, two email sends.
	if summary.Reminded != 1 {
		t.Fatalf("expected 1 reminder, got %+v", summary)
	}
	if len(notif.writes) != 2 {
		t.Fatalf("expected 2 notification writes (vendor + staff), got %d", len(notif.writes))
	}
	if len(fake.Calls) != 2 {
		t.Fatalf("email calls = %d, want exactly 2 (one vendor send, one staff send)", len(fake.Calls))
	}
	vendorCall := fake.Calls[0]
	if len(vendorCall.To) != 1 || vendorCall.To[0] != "vendor-r4@example.com" {
		t.Fatalf("vendor To = %v, want [vendor-r4@example.com]", vendorCall.To)
	}
	if len(vendorCall.Bcc) != 0 {
		t.Fatalf("vendor Bcc = %v, want empty on the vendor leg", vendorCall.Bcc)
	}
	if got := vendorCall.Subject; !containsCode(got, v.VisitID) {
		t.Fatalf("vendor subject = %q, want the visit code %q", got, v.VisitID)
	}
	staffCall := fake.Calls[1]
	if len(staffCall.To) != 2 || staffCall.To[0] != "admin-r4@thc.test" || staffCall.To[1] != "security-r4@thc.test" {
		t.Fatalf("staff To = %v, want the branch admin+security", staffCall.To)
	}
	if len(staffCall.Bcc) != 1 || staffCall.Bcc[0] != "super-r4@thc.test" {
		t.Fatalf("staff Bcc = %v, want the national overseers", staffCall.Bcc)
	}
	if got := staffCall.Subject; !containsCode(got, v.VisitID) {
		t.Fatalf("staff subject = %q, want the visit code %q", got, v.VisitID)
	}
}

// TestReminder_StaffSplitErrorKeepsVendorEmail proves a staff-leg resolver
// failure drops only the staff send: the vendor email still goes out and the
// sweep stays green.
func TestReminder_StaffSplitErrorKeepsVendorEmail(t *testing.T) {
	t.Parallel()
	// Given: an approved in-window visit whose staff split fails.
	v := reminderVisit("visit-r4staffail")
	visits := newFakeVisitRepo(v)
	rules := &fakeAutoRules{reminders: []domain.VisitRequest{v}}
	notif := &fakeNotificationRepo{
		recipients:   []string{"vendor-r4@example.com"},
		staffSplitErr: errTestSMTPDown,
	}
	fake := &domain.FakeMailer{}
	svc := workerServiceWithMailer(visits, rules, newFakeCheckInOutRepo(), notif, fake)
	// When: the sweep runs.
	summary := svc.Run(t.Context())
	// Then: the reminder counts and exactly the vendor email goes out.
	if summary.Reminded != 1 {
		t.Fatalf("expected 1 reminder, got %+v", summary)
	}
	if len(fake.Calls) != 1 {
		t.Fatalf("email calls = %d, want exactly 1 (vendor leg survives the staff failure)", len(fake.Calls))
	}
	if len(summary.Failures) != 0 {
		t.Fatalf("expected no failures, got %+v", summary.Failures)
	}
}

// TestReminder_NilMailerSendsZeroButStillNotifies proves a service built
// without a mailer (SMTP disabled) still writes the in_app reminder and
// counts it, with no fan-out attempt.
func TestReminder_NilMailerSendsZeroButStillNotifies(t *testing.T) {
	t.Parallel()
	// Given: an approved in-window visit on a mailer-less service.
	v := reminderVisit("visit-r4nomail")
	visits := newFakeVisitRepo(v)
	rules := &fakeAutoRules{reminders: []domain.VisitRequest{v}}
	notif := &fakeNotificationRepo{recipients: []string{"vendor-r4@example.com"}}
	svc := workerServiceWithNotifications(visits, rules, newFakeCheckInOutRepo(), notif)
	// When: the sweep runs.
	summary := svc.Run(t.Context())
	// Then: the reminder is counted and both legs written, with no mailer to fail it.
	if summary.Reminded != 1 {
		t.Fatalf("expected 1 reminder, got %+v", summary)
	}
	if len(notif.writes) != 2 {
		t.Fatalf("expected 2 notification writes (vendor + staff), got %d", len(notif.writes))
	}
	if len(summary.Failures) != 0 {
		t.Fatalf("expected no failures, got %+v", summary.Failures)
	}
}

// TestReminder_MailerErrorKeepsSweepGreen proves a mailer failure is a
// logged dead-letter, not a sweep failure: the reminder still counts and the
// attempt is recorded.
func TestReminder_MailerErrorKeepsSweepGreen(t *testing.T) {
	t.Parallel()
	// Given: an approved in-window visit with a failing mailer.
	v := reminderVisit("visit-r4failmail")
	visits := newFakeVisitRepo(v)
	rules := &fakeAutoRules{reminders: []domain.VisitRequest{v}}
	notif := &fakeNotificationRepo{recipients: []string{"vendor-r4@example.com"}}
	fake := &domain.FakeMailer{Err: errTestSMTPDown}
	svc := workerServiceWithMailer(visits, rules, newFakeCheckInOutRepo(), notif, fake)
	// When: the sweep runs.
	summary := svc.Run(t.Context())
	// Then: the sweep stays green and the attempt is recorded.
	if summary.Reminded != 1 {
		t.Fatalf("expected 1 reminder, got %+v", summary)
	}
	if len(summary.Failures) != 0 {
		t.Fatalf("expected no failures, got %+v", summary.Failures)
	}
	if len(fake.Calls) != 1 {
		t.Fatalf("email calls = %d, want 1 recorded attempt", len(fake.Calls))
	}
}

// TestReminder_EmptyRecipientsSendZero proves an inactive vendor (the
// resolver returns no addresses) still gains its in_app row while zero
// emails go out and the sweep stays green.
func TestReminder_EmptyRecipientsSendZero(t *testing.T) {
	t.Parallel()
	// Given: an approved in-window visit whose vendor resolves to nobody.
	v := reminderVisit("visit-r4quiet")
	visits := newFakeVisitRepo(v)
	rules := &fakeAutoRules{reminders: []domain.VisitRequest{v}}
	notif := &fakeNotificationRepo{}
	fake := &domain.FakeMailer{}
	svc := workerServiceWithMailer(visits, rules, newFakeCheckInOutRepo(), notif, fake)
	// When: the sweep runs.
	summary := svc.Run(t.Context())
	// Then: both in_app legs land, no email goes out, no failure.
	if summary.Reminded != 1 {
		t.Fatalf("expected 1 reminder, got %+v", summary)
	}
	if len(notif.writes) != 2 {
		t.Fatalf("expected 2 notification writes (vendor + staff), got %d", len(notif.writes))
	}
	if len(fake.Calls) != 0 {
		t.Fatalf("email calls = %d, want 0 for an empty recipient set", len(fake.Calls))
	}
	if len(summary.Failures) != 0 {
		t.Fatalf("expected no failures, got %+v", summary.Failures)
	}
}
