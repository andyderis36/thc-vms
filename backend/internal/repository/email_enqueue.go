package repository

import (
	"context"
	"log/slog"
	"strings"

	"github.com/google/uuid"
	"github.com/skip2/go-qrcode"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/repository/db"
)

// pendingEmail is one email captured inside a status-write transaction and
// fanned out only after the commit succeeds. A rolled-back transaction never
// produces one, so a notification without its email (or the reverse) is
// impossible in the same way as the in_app atomicity contract.
type pendingEmail struct {
	visit     domain.VisitRequest
	tpl       *domain.NotificationTemplate
	audiences []domain.NotificationAudience
}

// resolveEmailRecipients returns the active-only email addresses for one
// notification audience (kept as a variable so tests can stub a single leg
// without a database), mirroring the in_app fan-out predicates row for row:
// staff resolves exactly like InsertStaffNotifications (national active
// super_admins including the hidden dev-superadmin, plus the active
// admin/security of the visit's branch), vendor resolves exactly like
// InsertVendorNotification (the visit's vendor user holding the 'vendor'
// role) plus the active gate. An empty result is normal (inactive, pending,
// blacklisted, non-vendor or missing accounts) and never an error.
var resolveEmailRecipients = func(ctx context.Context, q *db.Queries, locationID, vendorUserID uuid.UUID, audience domain.NotificationAudience) ([]string, error) {
	switch audience {
	case domain.NotificationAudienceStaff:
		emails, err := q.ListStaffEmailRecipients(ctx, db.ListStaffEmailRecipientsParams{LocationID: locationID})
		if err != nil {
			return nil, MapError(err)
		}
		return emails, nil
	case domain.NotificationAudienceVendor:
		emails, err := q.ListVendorEmailRecipient(ctx, db.ListVendorEmailRecipientParams{VendorUserID: vendorUserID})
		if err != nil {
			return nil, MapError(err)
		}
		return emails, nil
	default:
		return nil, nil
	}
}

// splitStaffBcc partitions one resolved staff recipient set into the branch
// direct owners (To) and the national overseers (Bcc). Overseers are the
// active super_admin accounts incl. the hidden dev-superadmin, resolved by
// the role predicate — never by comparing against a single address — so a
// renamed or additional overseer account is classified correctly. When the
// overseer lookup fails, the split degrades to the old shape (everyone in
// To, empty Bcc) so the notification is never lost because of observability
// routing. staffActive false means no staff audience was enabled and both
// halves come back empty.
func splitStaffBcc(ctx context.Context, q *db.Queries, visitID string, template string, staffActive bool, staff []string) (to, bcc []string) {
	if !staffActive || len(staff) == 0 {
		return nil, nil
	}
	overseers, err := q.ListSuperAdminEmails(ctx)
	if err != nil {
		slog.Error("email overseer lookup failed, sending staff copy without Bcc split",
			"visit_id", visitID, "template", template, "err", err)
		return staff, nil
	}
	hidden := make(map[string]struct{}, len(overseers))
	for _, addr := range overseers {
		if trimmed := strings.TrimSpace(addr); trimmed != "" {
			hidden[strings.ToLower(trimmed)] = struct{}{}
		}
	}
	for _, addr := range staff {
		if _, ok := hidden[strings.ToLower(addr)]; ok {
			bcc = append(bcc, addr)
		} else {
			to = append(to, addr)
		}
	}
	return to, bcc
}

// resolveAdminEmailRecipients returns the active-only email set behind the
// visit_requested staff leg: every active national super_admin (including the
// hidden dev-superadmin) plus the active admin of the visit's branch — and
// deliberately no security role and no vendor. It mirrors
// ListAdminEmailRecipients the way resolveEmailRecipients mirrors its own
// fan-out predicates.
var resolveAdminEmailRecipients = func(ctx context.Context, q *db.Queries, locationID uuid.UUID) ([]string, error) {
	emails, err := q.ListAdminEmailRecipients(ctx, db.ListAdminEmailRecipientsParams{LocationID: locationID})
	if err != nil {
		return nil, MapError(err)
	}
	return emails, nil
}

// enqueueCreateEmail fans one visit_requested notice out to email AFTER the
// Create transaction that wrote its in_app row has committed. It never fails
// the caller: a nil mailer, a disabled toggle, an empty recipient set and
// every resolution or send failure only log and return. Non-mandatory OFF
// suppresses this mail through the shared EmailAllowedWithSettings gate.
//
// Recipients are staff-approvers only (branch admins in To, national
// overseers in Bcc through the shared splitStaffBcc): the filing vendor and
// the branch security roster are never mailed a new request.
func enqueueCreateEmail(ctx context.Context, mailer domain.Mailer, q *db.Queries, visit domain.VisitRequest, tpl *domain.NotificationTemplate, locationID uuid.UUID, frontendBaseURL string, snap domain.NotificationSettings) {
	if mailer == nil || tpl == nil || !domain.EmailAllowedWithSettings(tpl.Type, snap) {
		return
	}
	if !snap.IsEmailEnabled(tpl.Type, domain.NotificationAudienceStaff) {
		return
	}
	staff, err := resolveAdminEmailRecipients(ctx, q, locationID)
	if err != nil {
		slog.Error("email resolver failed, skipping audience",
			"visit_id", visit.VisitID, "template", string(tpl.Type),
			"audience", string(domain.NotificationAudienceStaff), "err", err)
		return
	}
	recipients := make([]string, 0, len(staff))
	seen := make(map[string]struct{}, len(staff))
	blankWarned := false
	for _, addr := range staff {
		trimmed := strings.TrimSpace(addr)
		if trimmed == "" {
			if !blankWarned {
				slog.Warn("email recipient skipped: blank address",
					"visit_id", visit.VisitID, "template", string(tpl.Type))
				blankWarned = true
			}
			continue
		}
		if _, dup := seen[trimmed]; dup {
			continue
		}
		seen[trimmed] = struct{}{}
		recipients = append(recipients, trimmed)
	}
	if len(recipients) == 0 {
		slog.Info("email skipped: no active recipients",
			"visit_id", visit.VisitID, "template", string(tpl.Type))
		return
	}
	subject, textBody, htmlBody := domain.BuildEmail(visit, tpl, frontendBaseURL)
	to, bcc := splitStaffBcc(ctx, q, visit.VisitID, string(tpl.Type), true, recipients)
	var sendErr error
	if tm, ok := mailer.(domain.TemplatedMailer); ok {
		sendErr = tm.SendTemplatedBcc(ctx, string(tpl.Type), to, bcc, subject, textBody, htmlBody)
	} else {
		sendErr = mailer.SendBcc(ctx, to, bcc, subject, textBody, htmlBody)
	}
	if sendErr != nil {
		slog.Error("email dead-letter",
			"visit_id", visit.VisitID, "template", string(tpl.Type),
			"recipient_count", len(to), "bcc_count", len(bcc), "err", sendErr)
	}
}

// hasVendorAudience reports whether a vendor-leg send is pending, in which
// case the roster must be loaded for the member fan-out.
func hasVendorAudience(audiences []domain.NotificationAudience) bool {
	for _, audience := range audiences {
		if audience == domain.NotificationAudienceVendor {
			return true
		}
	}
	return false
}

// attachMembers loads the visit roster inside the still-open status-write
// transaction and pins it onto the pending email, so the after-commit fan-out
// sees the same snapshot the in_app rows were written from. A roster read
// failure fails the write like any other in-transaction storage error.
func attachMembers(ctx context.Context, q *db.Queries, visitID uuid.UUID, pending *pendingEmail) error {
	rows, err := q.ListVisitors(ctx, db.ListVisitorsParams{VisitRequestIds: []uuid.UUID{visitID}})
	if err != nil {
		return MapError(err)
	}
	pending.visit.Visitors = make([]domain.Visitor, 0, len(rows))
	for _, row := range rows {
		pending.visit.Visitors = append(pending.visit.Visitors, visitorModelToDomain(row))
	}
	return nil
}

// attachPurposes loads the visit's reason catalogue inside the still-open
// status-write transaction and pins it onto the pending email, so the
// after-commit fan-out renders the same Purposes rows the single-GET read
// serves. A catalogue read failure fails the write like any other
// in-transaction storage error, mirroring attachMembers.
func attachPurposes(ctx context.Context, q *db.Queries, visitID uuid.UUID, pending *pendingEmail) error {
	rows, err := q.ListVisitPurposes(ctx, db.ListVisitPurposesParams{VisitRequestIds: []uuid.UUID{visitID}})
	if err != nil {
		return MapError(err)
	}
	pending.visit.Purposes = make([]domain.Purpose, 0, len(rows))
	for _, row := range rows {
		pending.visit.Purposes = append(pending.visit.Purposes, purposeModelToDomain(row))
	}
	return nil
}

// enqueueEmail fans one allowlisted template out to email AFTER the
// transaction that wrote its in_app rows has committed. It never fails the
// caller: a nil mailer (SMTP disabled), a nil or excluded template, an empty
// recipient set and every resolution or send failure only log and return. A
// failed audience leg is skipped while the surviving audiences still send, so
// one broken resolver can never drop the other legs. No channel='email' row is ever written: the in_app feed stays exactly what the
// transaction inserted. The send itself is non-blocking: the SMTP adapter
// queues and returns immediately, so no HTTP handler ever waits on delivery.
//
// Fan-out shape is visit-scoped: the staff audiences keep one single send
// to their active set, while the vendor audience fans out per recipient — one
// send to the requester plus one send to every roster member carrying a
// non-blank email, all sharing the same subject and bodies. The staff send
// puts the branch direct owners (admin/security of the visit's branch) in
// To and the national overseers (super_admin incl. the hidden
// dev-superadmin) in Bcc, so overseers stay informed without being visible
// to the branch recipients. The approval mail additionally carries the ONE
// team QR (payload = VST- code) as an inline-CID image in every fanned-out
// copy.
func enqueueEmail(ctx context.Context, mailer domain.Mailer, q *db.Queries, visit domain.VisitRequest, tpl *domain.NotificationTemplate, locationID, vendorUserID uuid.UUID, frontendBaseURL string, snap domain.NotificationSettings, audiences ...domain.NotificationAudience) {
	if mailer == nil || tpl == nil || !domain.EmailAllowedWithSettings(tpl.Type, snap) {
		return
	}
	var staffRecipients []string
	var vendorTargets []string
	seen := make(map[string]struct{})
	collect := func(dst *[]string, addr string) {
		trimmed := strings.TrimSpace(addr)
		if trimmed == "" {
			return
		}
		if _, dup := seen[trimmed]; dup {
			return
		}
		seen[trimmed] = struct{}{}
		*dst = append(*dst, trimmed)
	}
	blankWarned := false
	staffActive := false
	for _, audience := range audiences {
		if audience == domain.NotificationAudienceVendor && !snap.IsEmailEnabled(tpl.Type, domain.NotificationAudienceVendor) {
			continue
		}
		if audience != domain.NotificationAudienceVendor && !snap.IsEmailEnabled(tpl.Type, domain.NotificationAudienceStaff) {
			continue
		}
		if audience != domain.NotificationAudienceVendor {
			staffActive = true
		}
		emails, err := resolveEmailRecipients(ctx, q, locationID, vendorUserID, audience)
		if err != nil {
			slog.Error("email resolver failed, skipping audience",
				"visit_id", visit.VisitID, "template", string(tpl.Type),
				"audience", string(audience), "err", err)
			continue
		}
		for _, addr := range emails {
			if strings.TrimSpace(addr) == "" {
				if !blankWarned {
					slog.Warn("email recipient skipped: blank address",
						"visit_id", visit.VisitID, "template", string(tpl.Type))
					blankWarned = true
				}
				continue
			}
			if audience == domain.NotificationAudienceVendor {
				collect(&vendorTargets, addr)
			} else {
				collect(&staffRecipients, addr)
			}
		}
	}
	// Roster members ride along on the vendor leg only: a blank or missing
	// member email means no mail, never an error, so blanks skip silently.
	if snap.IsEmailEnabled(tpl.Type, domain.NotificationAudienceVendor) {
		for _, member := range visit.Visitors {
			if member.Email == nil {
				continue
			}
			if trimmed := strings.TrimSpace(*member.Email); trimmed != "" {
				collect(&vendorTargets, trimmed)
			}
		}
	}
	if len(staffRecipients) == 0 && len(vendorTargets) == 0 {
		slog.Info("email skipped: no active recipients",
			"visit_id", visit.VisitID, "template", string(tpl.Type))
		return
	}
	subject, textBody, htmlBody := domain.BuildEmail(visit, tpl, frontendBaseURL)
	// The lifecycle template label travels through the optional templated
	// port so the mail_log row carries it; adapters predating the port
	// (and every test fake) fall back to the plain sends with no behaviour
	// change.
	send := func(to []string) error {
		if tm, ok := mailer.(domain.TemplatedMailer); ok {
			return tm.SendTemplated(ctx, string(tpl.Type), to, subject, textBody, htmlBody)
		}
		return mailer.Send(ctx, to, subject, textBody, htmlBody)
	}
	// sendStaff delivers the single staff copy with the branch direct
	// owners in To and the national overseers in Bcc. The Bcc split is
	// best-effort: when the overseer lookup fails, the branch owners still
	// get the mail with everyone in To (the old shape) rather than losing
	// the notification.
	sendStaff := func(to, bcc []string) error {
		if tm, ok := mailer.(domain.TemplatedMailer); ok {
			return tm.SendTemplatedBcc(ctx, string(tpl.Type), to, bcc, subject, textBody, htmlBody)
		}
		return mailer.SendBcc(ctx, to, bcc, subject, textBody, htmlBody)
	}
	if len(staffRecipients) > 0 {
		staffTo, staffBcc := splitStaffBcc(ctx, q, visit.VisitID, string(tpl.Type), staffActive, staffRecipients)
		if err := sendStaff(staffTo, staffBcc); err != nil {
			slog.Error("email dead-letter",
				"visit_id", visit.VisitID, "template", string(tpl.Type),
				"recipient_count", len(staffTo), "bcc_count", len(staffBcc), "err", err)
		}
	}
	sendQR := func(to []string, qrPNG []byte, cid string) error {
		if tm, ok := mailer.(domain.TemplatedMailer); ok {
			return tm.SendTemplatedWithTeamQR(ctx, string(tpl.Type), to, subject, textBody, htmlBody, qrPNG, cid)
		}
		return mailer.SendWithTeamQR(ctx, to, subject, textBody, htmlBody, qrPNG, cid)
	}
	// Only the approval mail carries the team QR: one shared PNG encoded
	// from the VST- code, referenced from every fanned-out copy through the
	// same deterministic CID. An encoding failure degrades to plain sends
	// (the Kode-kunjungan text row stays the fallback) instead of dropping
	// the notification.
	var qrPNG []byte
	var cid string
	if tpl.Type == domain.NotificationVisitApproved && len(vendorTargets) > 0 {
		cid = domain.TeamQRCID(visit.VisitID)
		png, err := qrcode.Encode(visit.VisitID, qrcode.Medium, 256)
		if err != nil {
			slog.Error("email team QR encode failed, sending without image",
				"visit_id", visit.VisitID, "template", string(tpl.Type), "err", err)
			cid = ""
		} else {
			qrPNG = png
		}
	}
	for _, addr := range vendorTargets {
		var err error
		if qrPNG != nil {
			err = sendQR([]string{addr}, qrPNG, cid)
		} else {
			err = send([]string{addr})
		}
		if err != nil {
			slog.Error("email dead-letter",
				"visit_id", visit.VisitID, "template", string(tpl.Type),
				"recipient_count", 1, "err", err)
		}
	}
}
