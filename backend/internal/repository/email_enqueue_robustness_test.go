package repository

// Robustness suite for enqueueEmail (pure unit, no database): the resolver is
// stubbed per audience, so a failing leg is deterministic. Every test captures
// slog output the same way TestEmailEnqueue_MailerErrorStillSucceeds does.

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/google/uuid"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/repository/db"
)

// stubEmailResolver swaps the package resolver for one test; production code
// always uses the DB-backed implementation.
func stubEmailResolver(t *testing.T, fn func(ctx context.Context, q *db.Queries, locationID, vendorUserID uuid.UUID, audience domain.NotificationAudience) ([]string, error)) {
	t.Helper()
	orig := resolveEmailRecipients
	resolveEmailRecipients = fn
	t.Cleanup(func() { resolveEmailRecipients = orig })
}

// captureSlog routes the default slog output into a buffer for one test.
func captureSlog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	orig := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(orig) })
	return &buf
}

// robustVisit builds the minimal visit/template pair enqueueEmail needs: an
// allowlisted type plus the business code the log lines must carry.
func robustVisit() (domain.VisitRequest, *domain.NotificationTemplate) {
	visit := domain.VisitRequest{VisitID: "VST-0000000401"}
	tpl := &domain.NotificationTemplate{
		Type:     domain.NotificationVisitRescheduled,
		Title:    "Jadwal kunjungan diperbarui",
		Message:  "Permintaan VST-0000000401 dijadwalkan ulang.",
		Audience: domain.NotificationAudienceStaff,
	}
	return visit, tpl
}

// TestEmailEnqueue_StaffFailureStillSendsVendor proves one audience leg is
// independent: when the staff resolver fails but the vendor resolver succeeds,
// the vendor email is still enqueued instead of being dropped with the staff
// leg.
func TestEmailEnqueue_StaffFailureStillSendsVendor(t *testing.T) {
	const vendorAddr = "vendor.robust@vendor.test"
	stubEmailResolver(t, func(ctx context.Context, q *db.Queries, locationID, vendorUserID uuid.UUID, audience domain.NotificationAudience) ([]string, error) {
		if audience == domain.NotificationAudienceStaff {
			return nil, errors.New("staff directory unavailable")
		}
		return []string{vendorAddr}, nil
	})
	buf := captureSlog(t)

	fake := &domain.FakeMailer{}
	visit, tpl := robustVisit()
	enqueueEmail(context.Background(), fake, nil, visit, tpl,
		uuid.New(), uuid.New(),
		domain.NotificationAudienceStaff, domain.NotificationAudienceVendor)

	if len(fake.Calls) != 1 {
		t.Fatalf("email calls = %d, want 1 (surviving vendor leg must still send)", len(fake.Calls))
	}
	got := fake.Calls[0].To
	if len(got) != 1 || got[0] != vendorAddr {
		t.Fatalf("recipients = %v, want [%s]", got, vendorAddr)
	}
	logged := buf.String()
	if !strings.Contains(logged, "VST-0000000401") {
		t.Fatalf("resolver-failure log missing the visit code:\n%s", logged)
	}
	if strings.Contains(logged, vendorAddr) {
		t.Fatalf("resolver-failure log must not carry recipient addresses:\n%s", logged)
	}
}

// TestEmailEnqueue_LogsNeverCarryRecipientAddresses proves every slog line in
// the enqueue path carries only visit_id + template (+ counts) and never a
// full recipient address: recipients are PII and must not reach server logs.
// It exercises both the resolver-failure line (vendor leg survives, staff leg
// fails) and the dead-letter line (mailer errors after a successful resolve).
func TestEmailEnqueue_LogsNeverCarryRecipientAddresses(t *testing.T) {
	const staffAddr = "staff.robust@thc.test"
	const vendorAddr = "vendor.robust@vendor.test"
	stubEmailResolver(t, func(ctx context.Context, q *db.Queries, locationID, vendorUserID uuid.UUID, audience domain.NotificationAudience) ([]string, error) {
		if audience == domain.NotificationAudienceStaff {
			return nil, errors.New("staff directory unavailable")
		}
		return []string{staffAddr, vendorAddr}, nil
	})

	// Leg 1: resolver failure for one audience, surviving leg still sends
	// (one per-recipient send for each of its two resolved addresses).
	buf := captureSlog(t)
	fake := &domain.FakeMailer{}
	visit, tpl := robustVisit()
	enqueueEmail(context.Background(), fake, nil, visit, tpl,
		uuid.New(), uuid.New(),
		domain.NotificationAudienceStaff, domain.NotificationAudienceVendor)
	if len(fake.Calls) != 2 {
		t.Fatalf("email calls = %d, want 2 (one per surviving vendor recipient)", len(fake.Calls))
	}
	got := map[string]bool{}
	for _, call := range fake.Calls {
		if len(call.To) != 1 {
			t.Fatalf("recipients = %v, want one recipient per send", call.To)
		}
		got[call.To[0]] = true
	}
	for _, addr := range []string{staffAddr, vendorAddr} {
		if !got[addr] {
			t.Fatalf(" surviving sends = %v, want one send each to %q and %q", fake.Calls, staffAddr, vendorAddr)
		}
		if strings.Contains(buf.String(), addr) {
			t.Fatalf("resolver-failure log carries recipient %q:\n%s", addr, buf.String())
		}
	}

	// Leg 2: dead-letter after a fully successful resolve.
	buf.Reset()
	stubEmailResolver(t, func(ctx context.Context, q *db.Queries, locationID, vendorUserID uuid.UUID, audience domain.NotificationAudience) ([]string, error) {
		return []string{vendorAddr}, nil
	})
	broken := &domain.FakeMailer{Err: errors.New("smtp 421 downstream temporarily unavailable")}
	enqueueEmail(context.Background(), broken, nil, visit, tpl,
		uuid.New(), uuid.New(), domain.NotificationAudienceVendor)
	if len(broken.Calls) != 1 {
		t.Fatalf("dead-letter calls = %d, want 1 recorded attempt", len(broken.Calls))
	}
	logged := buf.String()
	if !strings.Contains(logged, "VST-0000000401") {
		t.Fatalf("dead-letter log missing the visit code:\n%s", logged)
	}
	if !strings.Contains(logged, string(domain.NotificationVisitRescheduled)) {
		t.Fatalf("dead-letter log missing the template type:\n%s", logged)
	}
	for _, addr := range []string{staffAddr, vendorAddr} {
		if strings.Contains(logged, addr) {
			t.Fatalf("dead-letter log carries recipient %q:\n%s", addr, logged)
		}
	}
}
