package repository

import (
	"context"
	"log/slog"
	"strings"

	"github.com/google/uuid"

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

// enqueueEmail fans one allowlisted template out to email AFTER the
// transaction that wrote its in_app rows has committed. It never fails the
// caller: a nil mailer (SMTP disabled), a nil or excluded template, an empty
// recipient set and every resolution or send failure only log and return. A
// failed audience leg is skipped while the surviving audiences still send, so
// one broken resolver can never drop the other legs. No channel='email' row is ever written: the in_app feed stays exactly what the
// transaction inserted. The send itself is non-blocking: the SMTP adapter
// queues and returns immediately, so no HTTP handler ever waits on delivery.
func enqueueEmail(ctx context.Context, mailer domain.Mailer, q *db.Queries, visit domain.VisitRequest, tpl *domain.NotificationTemplate, locationID, vendorUserID uuid.UUID, audiences ...domain.NotificationAudience) {
	if mailer == nil || tpl == nil || !domain.EmailAllowed(tpl.Type) {
		return
	}
	var recipients []string
	seen := make(map[string]struct{})
	for _, audience := range audiences {
		emails, err := resolveEmailRecipients(ctx, q, locationID, vendorUserID, audience)
		if err != nil {
			slog.Error("email resolver failed, skipping audience",
				"visit_id", visit.VisitID, "template", string(tpl.Type),
				"audience", string(audience), "err", err)
			continue
		}
		for _, addr := range emails {
			trimmed := strings.TrimSpace(addr)
			if trimmed == "" {
				slog.Warn("email recipient skipped: blank address",
					"visit_id", visit.VisitID, "template", string(tpl.Type))
				continue
			}
			if _, dup := seen[trimmed]; dup {
				continue
			}
			seen[trimmed] = struct{}{}
			recipients = append(recipients, trimmed)
		}
	}
	if len(recipients) == 0 {
		slog.Info("email skipped: no active recipients",
			"visit_id", visit.VisitID, "template", string(tpl.Type))
		return
	}
	subject, textBody, htmlBody := domain.BuildEmail(visit, tpl)
	if err := mailer.Send(ctx, recipients, subject, textBody, htmlBody); err != nil {
		slog.Error("email dead-letter",
			"visit_id", visit.VisitID, "template", string(tpl.Type),
			"recipient_count", len(recipients), "err", err)
	}
}
