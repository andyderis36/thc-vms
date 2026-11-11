package domain

import (
	"html"
	"strings"
	"time"
)

// This file owns the EMAIL RENDERING half of the lifecycle fan-out:
// BuildEmail turns one NotificationTemplate plus its visit context into the
// (subject, textBody, htmlBody) triple. The subject renders from the SAME
// template Title shown as the HTML H2, so subject and heading can never
// drift. The text part is the in_app Message verbatim plus the context rows;
// the HTML part is a branded wrapper around the same Title/Message. Every
// interpolated field is HTML-escaped. The sending port itself lives in
// mailer.go; this file only reads NotificationTemplate, never rewrites it.

// emailSubjectLine renders the locked subject convention for one canonical
// template title: "[THC-VMS] <Title> — {visit_code}". The title IS the H2 of
// the HTML body, so subject and heading can never drift.
func emailSubjectLine(title, visitCode string) string {
	return "[THC-VMS] " + title + " — " + visitCode
}

// emailScheduleLayout is the human-readable schedule rendering used in the
// HTML context rows (day-month-year, 24-hour clock).
const emailScheduleLayout = "02 Jan 2006 15:04"

// TeamQRCID renders the deterministic Content-ID of the approval team QR
// for a visit code: "qr-" + code. Deterministic so every fanned-out copy of
// the same approval mail references the one shared inline image.
func TeamQRCID(visitCode string) string {
	return "qr-" + visitCode
}

// teamQRNote is the locked Indonesian copy under the approval team QR.
const teamQRNote = "Satu QR Code untuk 1 tim. Pindai sekali untuk check-in bersama, dan sekali lagi untuk check-out bersama."

// emailBaseURL normalises the optional frontend base URL: a trailing slash is
// trimmed so callers can pass either "http://host" or "http://host/". An empty
// value keeps the legacy relative links ("/visits/...", "/qr") so existing
// 2-arg callers and tests keep compiling and rendering unchanged.
func emailBaseURL(frontendBaseURL ...string) string {
	if len(frontendBaseURL) == 0 {
		return ""
	}
	return strings.TrimRight(strings.TrimSpace(frontendBaseURL[0]), "/")
}

// BuildEmail renders the (subject, textBody, htmlBody) triple for one
// notification template in the context of its visit. The text body is the
// in_app Message verbatim; the HTML body wraps the in_app Title/Message in
// THC branding plus the location, schedule and (when the visit carries one)
// reason rows. All interpolated fields are HTML-escaped.
func BuildEmail(visit VisitRequest, tpl *NotificationTemplate, frontendBaseURL ...string) (subject, textBody, htmlBody string) {
	if tpl == nil {
		return "", "", ""
	}
	base := emailBaseURL(frontendBaseURL...)
	subject = emailSubjectLine(tpl.Title, visit.VisitID)
	textBody = buildEmailText(visit, tpl, base)
	htmlBody = renderEmailHTML(visit, tpl, base)
	return subject, textBody, htmlBody
}

// transitionActorLabels maps each human-transition email type onto its
// Indonesian actor-row label. Types absent from the map (reminder, the gate
// rows) render no transition-actor row.
var transitionActorLabels = map[NotificationType]string{
	NotificationVisitApproved:    "Disetujui oleh",
	NotificationVisitRejected:    "Ditolak oleh",
	NotificationVisitRescheduled: "Diubah oleh",
	NotificationVisitCancelled:   "Dibatalkan oleh",
}

// buildEmailText renders the plain-text body mirroring the HTML context rows.
func buildEmailText(visit VisitRequest, tpl *NotificationTemplate, base string) string {
	var b strings.Builder
	b.WriteString(tpl.Message)
	b.WriteString("\n\n")
	b.WriteString("Kode kunjungan: " + visit.VisitID + "\n")
	b.WriteString("Lokasi: " + visit.LocationName + "\n")
	b.WriteString("Jadwal: " + formatEmailSchedule(visit.StartDate, visit.EndDate) + "\n")
	if company := strings.TrimSpace(visit.VendorName); company != "" {
		b.WriteString("Vendor/Perusahaan: " + company + "\n")
	}
	if purposes := purposeNames(visit.Purposes); purposes != "" {
		b.WriteString("Keperluan: " + purposes + "\n")
	}
	if purposeNote := strings.TrimSpace(derefString(visit.PurposeNote)); purposeNote != "" {
		b.WriteString("Keperluan lain: " + purposeNote + "\n")
	}
	if requester := ActorLine(derefString(visit.CreatedByName), derefString(visit.CreatedByRoleLabel)); requester != "" {
		b.WriteString("Diajukan oleh: " + requester + "\n")
	}
	if label, ok := transitionActorLabels[tpl.Type]; ok {
		if actor := ActorLine(derefString(visit.ActorName), derefString(visit.ActorRoleLabel)); actor != "" {
			b.WriteString(label + ": " + actor + "\n")
		}
	}
	if reason := strings.TrimSpace(derefString(visit.StatusNote)); reason != "" {
		b.WriteString("Alasan: " + reason + "\n")
	}
	if notes := strings.TrimSpace(derefString(visit.Notes)); notes != "" {
		b.WriteString("Catatan: " + notes + "\n")
	}
	if names := visitorNames(visit.Visitors); names != "" {
		b.WriteString("Anggota tim: " + names + "\n")
	}
	if visit.CheckInAt != nil {
		b.WriteString("Waktu check-in: " + visit.CheckInAt.Format(emailScheduleLayout) + "\n")
	}
	if tpl.Type == NotificationVisitCheckIn {
		if actor := ActorLine(derefString(visit.ActorName), derefString(visit.ActorRoleLabel)); actor != "" {
			b.WriteString("Petugas check-in: " + actor + "\n")
		}
	}
	if visit.CheckOutAt != nil {
		b.WriteString("Waktu check-out: " + visit.CheckOutAt.Format(emailScheduleLayout) + "\n")
	}
	if tpl.Type == NotificationVisitCheckOut {
		if actor := ActorLine(derefString(visit.ActorName), derefString(visit.ActorRoleLabel)); actor != "" {
			b.WriteString("Petugas check-out: " + actor + "\n")
		}
	}
	if tpl.Type == NotificationVisitApproved {
		b.WriteString(teamQRNote + "\n")
	}
	visitLink := base + "/visits/" + visit.VisitID
	if base == "" {
		visitLink = "/visits/" + visit.VisitID
	}
	b.WriteString("Tautan: " + visitLink + "\n")
	if tpl.Type == NotificationVisitApproved {
		qrLink := base + "/qr"
		if base == "" {
			qrLink = "/qr"
		}
		b.WriteString("Tautan QR: " + qrLink + "\n")
	}
	return strings.TrimSpace(b.String())
}

// renderEmailHTML builds the branded HTML document. Context rows after the
// message: kode kunjungan, lokasi, jadwal, vendor/perusahaan, keperluan,
// tujuan lain (each only when the visit carries one), the requester/actor
// rows, alasan only when visit.StatusNote carries one, catatan only when
// visit.Notes carries one, plus timestamp/actor rows for check-in/out when
// present.
func renderEmailHTML(visit VisitRequest, tpl *NotificationTemplate, base string) string {
	var rows strings.Builder
	writeEmailRow(&rows, "Kode kunjungan", visit.VisitID)
	writeEmailRow(&rows, "Lokasi", visit.LocationName)
	writeEmailRow(&rows, "Jadwal", formatEmailSchedule(visit.StartDate, visit.EndDate))
	if company := strings.TrimSpace(visit.VendorName); company != "" {
		writeEmailRow(&rows, "Vendor/Perusahaan", company)
	}
	if purposes := purposeNames(visit.Purposes); purposes != "" {
		writeEmailRow(&rows, "Keperluan", purposes)
	}
	if purposeNote := strings.TrimSpace(derefString(visit.PurposeNote)); purposeNote != "" {
		writeEmailRow(&rows, "Keperluan lain", purposeNote)
	}
	if requester := ActorLine(derefString(visit.CreatedByName), derefString(visit.CreatedByRoleLabel)); requester != "" {
		writeEmailRow(&rows, "Diajukan oleh", requester)
	}
	if label, ok := transitionActorLabels[tpl.Type]; ok {
		if actor := ActorLine(derefString(visit.ActorName), derefString(visit.ActorRoleLabel)); actor != "" {
			writeEmailRow(&rows, label, actor)
		}
	}
	if reason := strings.TrimSpace(derefString(visit.StatusNote)); reason != "" {
		writeEmailRow(&rows, "Alasan", reason)
	}
	if notes := strings.TrimSpace(derefString(visit.Notes)); notes != "" {
		writeEmailRow(&rows, "Catatan", notes)
	}
	if names := visitorNames(visit.Visitors); names != "" {
		writeEmailRow(&rows, "Anggota tim", names)
	}
	if visit.CheckInAt != nil {
		writeEmailRow(&rows, "Waktu check-in", visit.CheckInAt.Format(emailScheduleLayout))
	}
	if tpl.Type == NotificationVisitCheckIn {
		if actor := ActorLine(derefString(visit.ActorName), derefString(visit.ActorRoleLabel)); actor != "" {
			writeEmailRow(&rows, "Petugas check-in", actor)
		}
	}
	if visit.CheckOutAt != nil {
		writeEmailRow(&rows, "Waktu check-out", visit.CheckOutAt.Format(emailScheduleLayout))
	}
	if tpl.Type == NotificationVisitCheckOut {
		if actor := ActorLine(derefString(visit.ActorName), derefString(visit.ActorRoleLabel)); actor != "" {
			writeEmailRow(&rows, "Petugas check-out", actor)
		}
	}
	qr := ""
	if tpl.Type == NotificationVisitApproved {
		qr = renderTeamQRSection(visit.VisitID)
	}
	// View-visit deep link CTA; the QR link rides only on the approval mail.
	viewLink := base + "/visits/" + visit.VisitID
	if base == "" {
		viewLink = "/visits/" + visit.VisitID
	}
	cta := `<table role="presentation" style="margin:16px 0 4px 0;border-collapse:collapse;"><tr><td style="background-color:#422AD5;border-radius:8px;">` +
		`<a href="` + html.EscapeString(viewLink) + `" style="display:inline-block;padding:12px 24px;color:#ffffff;font-size:14px;font-weight:bold;text-decoration:none;">Lihat Kunjungan</a></td></tr></table>`
	if tpl.Type == NotificationVisitApproved {
		qrLink := base + "/qr"
		if base == "" {
			qrLink = "/qr"
		}
		cta += `<p style="margin:8px 0 0 0;font-size:13px;"><a href="` + html.EscapeString(qrLink) + `">Tautan QR</a></p>`
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
		qr +
		cta +
		`</div>` +
		`<p style="margin:16px 0 0 0;color:#8a87a3;font-size:12px;text-align:center;">` +
		`Email otomatis dari THC-VMS. Mohon tidak membalas email ini.` +
		`</p>` +
		`</div></body></html>`
}

// renderTeamQRSection builds the approval-only team QR block: the inline-CID
// image (the attachment is embedded by the SMTP adapter under the same CID)
// plus the locked team note. The Kode-kunjungan context row above stays the
// text fallback, so a manually typed code still scans at the gate. The CID is
// escaped like every other interpolated field.
func renderTeamQRSection(visitCode string) string {
	cid := html.EscapeString(TeamQRCID(visitCode))
	return `<div style="margin:20px 0 4px 0;text-align:center;">` +
		`<img src="cid:` + cid + `" alt="QR Code tim" style="width:200px;height:200px;"/>` +
		`<p style="margin:12px 0 0 0;color:#3d3a52;font-size:14px;font-weight:bold;">` + teamQRNote + `</p>` +
		`</div>`
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

// visitorNames joins the roster into one comma-separated display string. A
// member with a resolved company renders "Nama (Perusahaan)"; a member without
// one renders the plain name. An empty roster (or all-blank names) yields ""
// so the row is omitted.
func visitorNames(visitors []Visitor) string {
	names := make([]string, 0, len(visitors))
	for _, v := range visitors {
		name := strings.TrimSpace(v.Name)
		if name == "" {
			continue
		}
		if company := strings.TrimSpace(v.VendorName); company != "" {
			name += " (" + company + ")"
		}
		names = append(names, name)
	}
	return strings.Join(names, ", ")
}

// purposeNames joins the visit-reason catalogue names into one comma-separated
// display string. Blank names are skipped, so an empty (or all-blank)
// catalogue yields "" and the row is omitted.
func purposeNames(purposes []Purpose) string {
	names := make([]string, 0, len(purposes))
	for _, p := range purposes {
		if n := strings.TrimSpace(p.Name); n != "" {
			names = append(names, n)
		}
	}
	return strings.Join(names, ", ")
}

// ActorLine renders "Nama (Label Peran)" for the email actor rows and the
// cancel message: the name wins, the role label is the fallback, and two
// empty inputs render "" so callers omit the row instead of printing a bare
// UUID.
func ActorLine(name, roleLabel string) string {
	name = strings.TrimSpace(name)
	label := strings.TrimSpace(roleLabel)
	switch {
	case name != "" && label != "":
		return name + " (" + label + ")"
	case name != "":
		return name
	case label != "":
		return label
	default:
		return ""
	}
}
