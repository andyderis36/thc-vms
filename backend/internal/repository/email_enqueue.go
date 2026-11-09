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
// Fan-out shape is visit-scoped: the staff audiences keep one single send to
// their active set, while the vendor audience fans out per recipient — one
// send to the requester plus one send to every roster member carrying a
// non-blank email, all sharing the same subject and bodies. The approval mail
// additionally carries the ONE team QR (payload = VST- code) as an inline-CID
// image in every fanned-out copy.
func enqueueEmail(ctx context.Context, mailer domain.Mailer, q *db.Queries, visit domain.VisitRequest, tpl *domain.NotificationTemplate, locationID, vendorUserID uuid.UUID, frontendBaseURL string, audiences ...domain.NotificationAudience) {
	if mailer == nil || tpl == nil || !domain.EmailAllowed(tpl.Type) {
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
	for _, audience := range audiences {
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
	for _, member := range visit.Visitors {
		if member.Email == nil {
			continue
		}
		if trimmed := strings.TrimSpace(*member.Email); trimmed != "" {
			collect(&vendorTargets, trimmed)
		}
	}
	if len(staffRecipients) == 0 && len(vendorTargets) == 0 {
		slog.Info("email skipped: no active recipients",
			"visit_id", visit.VisitID, "template", string(tpl.Type))
		return
	}
	subject, textBody, htmlBody := domain.BuildEmail(visit, tpl, frontendBaseURL)
	if len(staffRecipients) > 0 {
		if err := mailer.Send(ctx, staffRecipients, subject, textBody, htmlBody); err != nil {
			slog.Error("email dead-letter",
				"visit_id", visit.VisitID, "template", string(tpl.Type),
				"recipient_count", len(staffRecipients), "err", err)
		}
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
			err = mailer.SendWithTeamQR(ctx, []string{addr}, subject, textBody, htmlBody, qrPNG, cid)
		} else {
			err = mailer.Send(ctx, []string{addr}, subject, textBody, htmlBody)
		}
		if err != nil {
			slog.Error("email dead-letter",
				"visit_id", visit.VisitID, "template", string(tpl.Type),
				"recipient_count", 1, "err", err)
		}
	}
}
