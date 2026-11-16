package domain

import (
	"context"
	"strings"
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
// SendBcc puts the direct owners in To and the national overseers
// (super_admin incl. the hidden dev-superadmin) in Bcc, so overseers stay
// informed without being visible to the direct recipients.
// SendWithTeamQR sends the same message with one inline-CID PNG attached
// (the approval team QR); qrPNG is the encoded image bytes and cid its
// Content-ID, referenced from the HTML as "cid:<cid>".
type Mailer interface {
	Send(ctx context.Context, to []string, subject, textBody, htmlBody string) error
	SendBcc(ctx context.Context, to, bcc []string, subject, textBody, htmlBody string) error
	SendWithTeamQR(ctx context.Context, to []string, subject, textBody, htmlBody string, qrPNG []byte, cid string) error
}

// TemplatedMailer is the optional sending port for lifecycle fan-outs that
// know their notification template. It mirrors Mailer one-to-one but carries
// the template label (e.g. visit_approved) alongside, so the single flush
// point (the SMTP worker) can stamp the mail_log row without changing the
// send/retry behaviour. Callers that go through it MUST keep the plain Mailer
// fallback: adapters that predate the port (and every test fake) only
// implement Mailer, and the label is observability metadata, never a reason
// to refuse a send.
type TemplatedMailer interface {
	Mailer
	SendTemplated(ctx context.Context, template string, to []string, subject, textBody, htmlBody string) error
	SendTemplatedBcc(ctx context.Context, template string, to, bcc []string, subject, textBody, htmlBody string) error
	SendTemplatedWithTeamQR(ctx context.Context, template string, to []string, subject, textBody, htmlBody string, qrPNG []byte, cid string) error
}

// emailAllowedTypes is the single email allowlist. Exactly these nine
// lifecycle types may fan out to email. visit_requested IS emailed, but only
// on the staff leg: the branch admins plus the national overseers are told of
// every new request, while the vendor (who filed it) and the branch security
// get no mail. visit_auto_cancelled IS emailed: the R1 stale-request sweep
// and the R2 no-show sweep share this one type (splitting them would need a
// migration), so both legs notify the vendor by design.
var emailAllowedTypes = map[NotificationType]struct{}{
	NotificationVisitRequested:     {},
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

// SplitOverseerBcc carves the hidden dev-superadmin address out of a flat
// recipient list: direct owners stay in To, the dev address moves to Bcc.
// Case-insensitive and trims blanks; returns nil slices when empty so the
// caller can skip the send exactly like a blank To. Used by fan-outs that
// only resolve flat email lists (no role information available).
func SplitOverseerBcc(recipients []string) (to, bcc []string) {
	for _, addr := range recipients {
		trimmed := strings.TrimSpace(addr)
		if trimmed == "" {
			continue
		}
		if strings.EqualFold(trimmed, DevSuperadminEmail) {
			bcc = append(bcc, trimmed)
		} else {
			to = append(to, trimmed)
		}
	}
	return to, bcc
}

// MailCall is one recorded FakeMailer.Send invocation. QRPNG/QRCID carry
// the team QR attached through SendWithTeamQR; both stay empty for plain
// Send calls and for every non-approval mail.
type MailCall struct {
	To       []string
	Bcc      []string
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

// SendBcc records the call with its Bcc set and returns the configured
// error, mirroring Send without touching the network.
func (f *FakeMailer) SendBcc(ctx context.Context, to, bcc []string, subject, textBody, htmlBody string) error {
	_ = ctx
	f.Calls = append(f.Calls, MailCall{To: to, Bcc: bcc, Subject: subject, TextBody: textBody, HTMLBody: htmlBody})
	return f.Err
}

// SendWithTeamQR records the call with its inline image and returns the
// configured error, mirroring Send without touching the network.
func (f *FakeMailer) SendWithTeamQR(ctx context.Context, to []string, subject, textBody, htmlBody string, qrPNG []byte, cid string) error {
	_ = ctx
	f.Calls = append(f.Calls, MailCall{To: to, Subject: subject, TextBody: textBody, HTMLBody: htmlBody, QRPNG: qrPNG, QRCID: cid})
	return f.Err
}
