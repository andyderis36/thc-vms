package domain

import (
	"context"
	"html"
	"strings"
	"time"
)

// This file owns the EMAIL fan-out contract for visit lifecycle notices.
//
//   - Mailer is the sending port: the go-mail adapter (infrastructure)
//     implements it in a later task; the usecase only depends on this
//     interface, so no SMTP library, network call or env read ever enters
//     the domain or usecase layers.
//   - emailAllowedTypes is the ONE source of truth for which notification
//     types may leave the system as email. Adding a type is literally one
//     map line; EmailAllowed is the gate callers check at enqueue time.
//   - BuildEmail renders (subject, textBody, htmlBody) from the existing
//     Indonesian in_app Title/Message vocabulary plus the visit context.
//     The text part is the in_app Message verbatim (one copy, two
//     channels); the HTML part is a branded wrapper around the same
//     Title/Message with the location, schedule and (when present) reason
//     rows. Every interpolated field is HTML-escaped.
//
// Existing notification templates, audiences and the in_app path are
// untouched: this file only reads NotificationTemplate, never rewrites it.

// Mailer is the outbound email port. Implementations (the go-mail SMTP
// adapter) send one message; to holds the envelope recipients, subject is
// the [THC-VMS] line, and textBody/htmlBody are the two MIME parts.
type Mailer interface {
	Send(ctx context.Context, to []string, subject, textBody, htmlBody string) error
}

// emailAllowedTypes is the single email allowlist. Exactly these seven
// lifecycle types may fan out to email; notably visit_requested stays
// in_app-only (staff triage the dashboard, they are not emailed every new
// request) and visit_auto_cancelled stays silent (administrative
// housekeeping the vendor already sees as a status change).
var emailAllowedTypes = map[NotificationType]struct{}{
	NotificationVisitApproved:    {},
	NotificationVisitRejected:    {},
	NotificationVisitCancelled:   {},
	NotificationVisitRescheduled: {},
	NotificationVisitReminder:    {},
	NotificationVisitCheckIn:     {},
	NotificationVisitCheckOut:    {},
}

// EmailAllowed reports whether a notification type may be sent as email.
// Callers check this at enqueue time and drop anything it rejects before
// any Mailer.Send call is ever made.
func EmailAllowed(t NotificationType) bool {
	_, ok := emailAllowedTypes[t]
	return ok
}

// emailSubjectTitles is the locked subject table: each allowlisted type maps
// onto its Indonesian Judul rendered as "[THC-VMS] <Judul> — {visit_code}".
var emailSubjectTitles = map[NotificationType]string{
	NotificationVisitApproved:    "Kunjungan Disetujui",
	NotificationVisitRejected:    "Kunjungan Ditolak",
	NotificationVisitCancelled:   "Kunjungan Dibatalkan",
	NotificationVisitRescheduled: "Jadwal Diubah",
	NotificationVisitReminder:    "Pengingat Kunjungan (H-1)",
	NotificationVisitCheckIn:     "Check-in Tercatat",
	NotificationVisitCheckOut:    "Check-out Tercatat",
}

// EmailSubject renders the locked subject line for a type and visit code.
// Types outside the locked table fall back to the in_app title so the
// helper stays total; the allowlist (not this fallback) is what decides
// whether the message is ever sent.
func EmailSubject(t NotificationType, visitCode string) string {
	if judul, ok := emailSubjectTitles[t]; ok {
		return "[THC-VMS] " + judul + " — " + visitCode
	}
	return "[THC-VMS] " + string(t) + " — " + visitCode
}

// emailScheduleLayout is the human-readable schedule rendering used in the
// HTML context rows (day-month-year, 24-hour clock).
const emailScheduleLayout = "02 Jan 2006 15:04"

// BuildEmail renders the (subject, textBody, htmlBody) triple for one
// notification template in the context of its visit. The text body is the
// in_app Message verbatim; the HTML body wraps the in_app Title/Message in
// THC branding plus the location, schedule and (when the visit carries one)
// reason rows. All interpolated fields are HTML-escaped.
func BuildEmail(visit VisitRequest, tpl *NotificationTemplate) (subject, textBody, htmlBody string) {
	if tpl == nil {
		return "", "", ""
	}
	subject = EmailSubject(tpl.Type, visit.VisitID)
	textBody = tpl.Message
	htmlBody = renderEmailHTML(visit, tpl)
	return subject, textBody, htmlBody
}

// renderEmailHTML builds the branded HTML document. Context rows after the
// message: kode kunjungan, lokasi, jadwal, and alasan only when
// visit.StatusNote carries one.
func renderEmailHTML(visit VisitRequest, tpl *NotificationTemplate) string {
	var rows strings.Builder
	writeEmailRow(&rows, "Kode kunjungan", visit.VisitID)
	writeEmailRow(&rows, "Lokasi", visit.LocationName)
	writeEmailRow(&rows, "Jadwal", formatEmailSchedule(visit.StartDate, visit.EndDate))
	if reason := strings.TrimSpace(derefString(visit.StatusNote)); reason != "" {
		writeEmailRow(&rows, "Alasan", reason)
	}

	return `<!DOCTYPE html>` +
		`<html lang="id"><head><meta charset="utf-8"></head>` +
		`<body style="margin:0;padding:0;background-color:#f4f2fb;font-family:Arial,Helvetica,sans-serif;">` +
		`<div style="max-width:560px;margin:0 auto;padding:24px;">` +
		`<div style="background-color:#422AD5;color:#ffffff;padding:16px 24px;border-radius:8px 8px 0 0;">` +
		`<strong style="font-size:18px;">THC Visitor Management System</strong>` +
		`</div>` +
		`<div style="background-color:#ffffff;padding:24px;border:1px solid #e5e1f5;border-top:none;border-radius:0 0 8px 8px;">` +
		`<h2 style="margin:0 0 12px 0;color:#1f1b3a;font-size:18px;">` + html.EscapeString(tpl.Title) + `</h2>` +
		`<p style="margin:0 0 16px 0;color:#3d3a52;font-size:14px;line-height:1.6;">` + html.EscapeString(tpl.Message) + `</p>` +
		`<table style="width:100%;border-collapse:collapse;font-size:14px;">` + rows.String() + `</table>` +
		`</div>` +
		`<p style="margin:16px 0 0 0;color:#8a87a3;font-size:12px;text-align:center;">` +
		`Email otomatis dari THC-VMS. Mohon tidak membalas email ini.` +
		`</p>` +
		`</div></body></html>`
}

// RenderBrandedActionEmail builds a branded HTML document like
// renderEmailHTML (same header, card and footer) but driven by an explicit
// title/message pair plus an optional call-to-action button. Empty ctaLabel
// or ctaURL renders no button. Every interpolated field is HTML-escaped,
// including the URL inside the href attribute.
func RenderBrandedActionEmail(title, message, ctaLabel, ctaURL string) string {
	button := ""
	if strings.TrimSpace(ctaLabel) != "" && strings.TrimSpace(ctaURL) != "" {
		button = `<table role="presentation" style="margin:16px 0 4px 0;border-collapse:collapse;"><tr><td style="background-color:#422AD5;border-radius:8px;">` +
			`<a href="` + html.EscapeString(ctaURL) + `" style="display:inline-block;padding:12px 24px;color:#ffffff;font-size:14px;font-weight:bold;text-decoration:none;">` +
			html.EscapeString(ctaLabel) + `</a></td></tr></table>`
	}

	return `<!DOCTYPE html>` +
		`<html lang="id"><head><meta charset="utf-8"></head>` +
		`<body style="margin:0;padding:0;background-color:#f4f2fb;font-family:Arial,Helvetica,sans-serif;">` +
		`<div style="max-width:560px;margin:0 auto;padding:24px;">` +
		`<div style="background-color:#422AD5;color:#ffffff;padding:16px 24px;border-radius:8px 8px 0 0;">` +
		`<strong style="font-size:18px;">THC Visitor Management System</strong>` +
		`</div>` +
		`<div style="background-color:#ffffff;padding:24px;border:1px solid #e5e1f5;border-top:none;border-radius:0 0 8px 8px;">` +
		`<h2 style="margin:0 0 12px 0;color:#1f1b3a;font-size:18px;">` + html.EscapeString(title) + `</h2>` +
		`<p style="margin:0 0 16px 0;color:#3d3a52;font-size:14px;line-height:1.6;">` + html.EscapeString(message) + `</p>` +
		button +
		`</div>` +
		`<p style="margin:16px 0 0 0;color:#8a87a3;font-size:12px;text-align:center;">` +
		`Email otomatis dari THC-VMS. Mohon tidak membalas email ini.` +
		`</p>` +
		`</div></body></html>`
}

// writeEmailRow appends one escaped label/value row to the context table.
func writeEmailRow(rows *strings.Builder, label, value string) {
	rows.WriteString(`<tr>`)
	rows.WriteString(`<td style="padding:8px 12px 8px 0;color:#8a87a3;vertical-align:top;white-space:nowrap;">` + html.EscapeString(label) + `</td>`)
	rows.WriteString(`<td style="padding:8px 0;color:#1f1b3a;vertical-align:top;">` + html.EscapeString(value) + `</td>`)
	rows.WriteString(`</tr>`)
}

// formatEmailSchedule renders "start s/d end"; a zero end collapses to the
// start alone so half-filled windows still read sensibly.
func formatEmailSchedule(start, end time.Time) string {
	if end.IsZero() || end.Equal(start) {
		return start.Format(emailScheduleLayout)
	}
	return start.Format(emailScheduleLayout) + " s/d " + end.Format(emailScheduleLayout)
}

// derefString unwraps an optional note, tolerating nil.
func derefString(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// MailCall is one recorded FakeMailer.Send invocation.
type MailCall struct {
	To       []string
	Subject  string
	TextBody string
	HTMLBody string
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
