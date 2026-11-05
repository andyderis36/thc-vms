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

// TestReminder_EnqueuesOneVendorEmail proves an in-window reminder enqueues
// exactly one email to the resolved vendor address with the visit code in
// the subject.
func TestReminder_EnqueuesOneVendorEmail(t *testing.T) {
	t.Parallel()
	// Given: an approved in-window visit and a resolver returning one address.
	v := reminderVisit("visit-r4mail")
	visits := newFakeVisitRepo(v)
	rules := &fakeAutoRules{reminders: []domain.VisitRequest{v}}
	notif := &fakeNotificationRepo{recipients: []string{"vendor-r4@example.com"}}
	fake := &domain.FakeMailer{}
	svc := workerServiceWithMailer(visits, rules, newFakeCheckInOutRepo(), notif, fake)
	// When: the sweep runs.
	summary := svc.Run(t.Context())
	// Then: one in_app reminder and exactly one email to the vendor.
	if summary.Reminded != 1 {
		t.Fatalf("expected 1 reminder, got %+v", summary)
	}
	if len(notif.writes) != 1 {
		t.Fatalf("expected 1 notification write, got %d", len(notif.writes))
	}
	if len(fake.Calls) != 1 {
		t.Fatalf("email calls = %d, want exactly 1", len(fake.Calls))
	}
	call := fake.Calls[0]
	if len(call.To) != 1 || call.To[0] != "vendor-r4@example.com" {
		t.Fatalf("To = %v, want [vendor-r4@example.com]", call.To)
	}
	if got := call.Subject; !containsCode(got, v.VisitID) {
		t.Fatalf("subject = %q, want the visit code %q", got, v.VisitID)
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
	// Then: the reminder is counted and written, with no mailer to fail it.
	if summary.Reminded != 1 {
		t.Fatalf("expected 1 reminder, got %+v", summary)
	}
	if len(notif.writes) != 1 {
		t.Fatalf("expected 1 notification write, got %d", len(notif.writes))
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
	// Then: the in_app reminder lands, no email goes out, no failure.
	if summary.Reminded != 1 {
		t.Fatalf("expected 1 reminder, got %+v", summary)
	}
	if len(notif.writes) != 1 {
		t.Fatalf("expected 1 notification write, got %d", len(notif.writes))
	}
	if len(fake.Calls) != 0 {
		t.Fatalf("email calls = %d, want 0 for an empty recipient set", len(fake.Calls))
	}
	if len(summary.Failures) != 0 {
		t.Fatalf("expected no failures, got %+v", summary.Failures)
	}
}
