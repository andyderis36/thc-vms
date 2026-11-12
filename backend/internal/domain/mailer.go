package domain

import (
	"context"
)

// This file owns the EMAIL SENDING contract for visit lifecycle notices:
//
//   - Mailer is the sending port: the go-mail adapter (infrastructure)
//     implements it; the usecase only depends on this interface, so no SMTP
//     library, network call or env read ever enters the domain or usecase
//     layers.
//   - emailAllowedTypes is the ONE source of truth for which notification
//     types may leave the system as email. Adding a type is literally one
//     map line; EmailAllowed is the gate callers check at enqueue time.
//   - MailCall/FakeMailer are the in-memory recording port for tests.
//
// The rendering half (BuildEmail and friends) lives in email_render.go.

// Mailer is the outbound email port. Implementations (the go-mail SMTP
// adapter) send one message; to holds the envelope recipients, subject is
// the [THC-VMS] line, and textBody/htmlBody are the two MIME parts.
// SendWithTeamQR sends the same message with one inline-CID PNG attached
// (the approval team QR); qrPNG is the encoded image bytes and cid its
// Content-ID, referenced from the HTML as "cid:<cid>".
type Mailer interface {
	Send(ctx context.Context, to []string, subject, textBody, htmlBody string) error
	SendWithTeamQR(ctx context.Context, to []string, subject, textBody, htmlBody string, qrPNG []byte, cid string) error
}

// emailAllowedTypes is the single email allowlist. Exactly these eight
// lifecycle types may fan out to email; notably visit_requested stays
// in_app-only (staff triage the dashboard, they are not emailed every new
// request). visit_auto_cancelled IS emailed: the R1 stale-request sweep and
// the R2 no-show sweep share this one type (splitting them would need a
// migration), so both legs notify the vendor by design.
var emailAllowedTypes = map[NotificationType]struct{}{
	NotificationVisitApproved:      {},
	NotificationVisitRejected:      {},
	NotificationVisitCancelled:     {},
	NotificationVisitAutoCancelled: {},
	NotificationVisitRescheduled:   {},
	NotificationVisitReminder:      {},
	NotificationVisitCheckIn:       {},
	NotificationVisitCheckOut:      {},
}

// EmailAllowedWithSettings reports whether a notification type may be sent as
// email under the given settings snapshot. Mandatory types always return true
// (even when stored Off); non-mandatory types require both the type-level
// capability (emailAllowedTypes) and an enabled email toggle in the snapshot.
func EmailAllowedWithSettings(t NotificationType, snap NotificationSettings) bool {
	if _, ok := MandatoryNotificationTypes[t]; ok {
		return true
	}
	if _, ok := emailAllowedTypes[t]; !ok {
		return false
	}
	return snap.IsEmailEnabled(t, NotificationAudienceStaff) || snap.IsEmailEnabled(t, NotificationAudienceVendor)
}

// EmailAllowed reports whether a notification type may be sent as email.
// Callers check this at enqueue time and drop anything it rejects before
// any Mailer.Send call is ever made. It delegates to
// EmailAllowedWithSettings with the default-Active snapshot so existing
// callers and tests keep their behaviour.
func EmailAllowed(t NotificationType) bool {
	return EmailAllowedWithSettings(t, DefaultNotificationSettings())
}

// MailCall is one recorded FakeMailer.Send invocation. QRPNG/QRCID carry
// the team QR attached through SendWithTeamQR; both stay empty for plain
// Send calls and for every non-approval mail.
type MailCall struct {
	To       []string
	Subject  string
	TextBody string
	HTMLBody string
	QRPNG    []byte
	QRCID    string
}

// FakeMailer is the in-memory Mailer for unit tests: it records every Send
// call and returns Err (nil by default). It performs no I/O.
type FakeMailer struct {
	Calls []MailCall
	Err   error
}

// Send records the call and returns the configured error.
func (f *FakeMailer) Send(ctx context.Context, to []string, subject, textBody, htmlBody string) error {
	_ = ctx
	f.Calls = append(f.Calls, MailCall{To: to, Subject: subject, TextBody: textBody, HTMLBody: htmlBody})
	return f.Err
}

// SendWithTeamQR records the call with its inline image and returns the
// configured error, mirroring Send without touching the network.
func (f *FakeMailer) SendWithTeamQR(ctx context.Context, to []string, subject, textBody, htmlBody string, qrPNG []byte, cid string) error {
	_ = ctx
	f.Calls = append(f.Calls, MailCall{To: to, Subject: subject, TextBody: textBody, HTMLBody: htmlBody, QRPNG: qrPNG, QRCID: cid})
	return f.Err
}
