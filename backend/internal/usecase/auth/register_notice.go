package auth

import (
	"context"
	"fmt"
	"html"
	"log/slog"
	"strings"

	"thc-vms/backend/internal/domain"
)

// SuperAdminDirectory resolves the staff email set behind the vendor
// registration fan-out: every ACTIVE account holding the super_admin or the
// hidden dev-superadmin role, ordered by email. The predicate mirrors the
// ListStaffEmailRecipients one minus the branch leg — there is deliberately
// NO location predicate and NO admin/security roles here (a national queue,
// not a visit at one branch). The production SQL adapter arrives in a later
// wave; tests use a slice fake.
type SuperAdminDirectory interface {
	ListSuperAdminEmails(ctx context.Context) ([]string, error)
}

// publishVendorRegistration runs the post-create fan-out for one
// self-registered vendor: UpsertPending anchors the durable queue row (the
// superadmin approval bell), then the active superadmin set gets one
// best-effort email. Everything here is best-effort: a queue failure, a
// resolver failure, a nil mailer or a send failure is logged and the
// registration still stands with 201, because the account row already
// committed.
func (s *Service) publishVendorRegistration(ctx context.Context, user domain.User) {
	if s.notices == nil {
		slog.Warn("auth: vendor registration notice skipped: VendorRegistrationNoticeRepository not wired", "user_id", string(user.ID))
		return
	}
	if err := s.notices.InsertPending(ctx, user.ID); err != nil {
		slog.Error("auth: vendor registration notice insert failed", "user_id", string(user.ID), "error", err)
	}
	s.mailSuperAdmins(ctx, user)
}

// mailSuperAdmins resolves the active superadmin recipients and sends the
// single registration notice. A nil directory or a nil mailer disables only
// the email leg; a resolver failure or an empty recipient set only logs and
// returns. Exactly one Send call is ever made per registration.
func (s *Service) mailSuperAdmins(ctx context.Context, user domain.User) {
	if s.superAdmins == nil || s.mailer == nil {
		return
	}
	emails, err := s.superAdmins.ListSuperAdminEmails(ctx)
	if err != nil {
		slog.Error("auth: superadmin recipient resolver failed, dropping vendor registration email", "user_id", string(user.ID), "error", err)
		return
	}
	var recipients []string
	for _, addr := range emails {
		trimmed := strings.TrimSpace(addr)
		if trimmed == "" {
			slog.Warn("auth: vendor registration email recipient skipped: blank address", "user_id", string(user.ID))
			continue
		}
		recipients = append(recipients, trimmed)
	}
	if len(recipients) == 0 {
		slog.Info("auth: vendor registration email skipped: no active superadmin recipients", "user_id", string(user.ID))
		return
	}
	name := strings.TrimSpace(user.Name)
	identifier := strings.TrimSpace(user.Email)
	if name != "" {
		identifier = name
	}
	subject := domain.VendorRegistrationSubject(identifier)
	textBody := fmt.Sprintf("Vendor baru %s (%s) baru saja mendaftar dan menunggu persetujuan akun. Tinjau antrean pendaftaran vendor untuk menyetujui atau menolaknya.", identifier, strings.TrimSpace(user.Email))
	htmlBody := `<p>` + html.EscapeString(textBody) + `</p>`
	if err := s.mailer.Send(ctx, recipients, subject, textBody, htmlBody); err != nil {
		slog.Warn("auth: vendor registration email failed", "user_id", string(user.ID), "error", err)
	}
}

// mailVendorPending mails the pending receipt to the VENDOR inbox itself:
// pendaftaran diterima, sedang diproses, mohon menunggu verifikasi admin.
// Strictly best-effort like the superadmin leg: a nil mailer, a blank address
// or a send failure only logs (slog.Warn) and never fails the 201, because
// the account row already committed.
func (s *Service) mailVendorPending(ctx context.Context, user domain.User) {
	if s.mailer == nil {
		return
	}
	to := strings.TrimSpace(user.Email)
	if to == "" {
		slog.Warn("auth: vendor pending mail skipped", "user_id", string(user.ID), "reason", "blank_address")
		return
	}
	text := "Pendaftaran akun vendor Anda sudah diterima dan sedang diproses. Mohon menunggu verifikasi admin sebelum Anda dapat masuk dan mengajukan kunjungan."
	htmlBody := domain.RenderBrandedActionEmail("Pendaftaran Diterima", text, "", "")
	if err := s.mailer.Send(ctx, []string{to}, "[THC-VMS] Pendaftaran Diterima — Menunggu Verifikasi Admin", text, htmlBody); err != nil {
		slog.Warn("auth: vendor pending mail failed", "user_id", string(user.ID), "error", err)
	}
}

// EnsureVendorRegistrationNotice (re)queues one registration notice row for a
// vendor account idempotently (UNIQUE vendor_user_id, ON CONFLICT DO
// NOTHING). It is the usecase leg behind the superadmin account-status
// change flipping a vendor back TO pending (PATCH /users/:id/status): the
// account write itself stays on the managed-user path, this only anchors the
// queue row so the bell cannot stay empty for a pending account. A nil queue
// is a wiring bug (500); a store failure maps through FromError. Callers
// treat both as best-effort: the status flip already committed.
func (s *Service) EnsureVendorRegistrationNotice(ctx context.Context, vendorUserID domain.UUID) error {
	if s.notices == nil {
		return domain.FromError(errUnwired)
	}
	if err := s.notices.InsertPending(ctx, vendorUserID); err != nil {
		return domain.FromError(err)
	}
	return nil
}

// ResolveVendorRegistration flips one registration queue row to
// approved/rejected and stamps resolved_at. It is the usecase leg behind the
// superadmin account-status change (PATCH /users/:id/status flipping a
// pending vendor to active/inactive): the account write itself stays on the
// managed-user path, this only resolves the queue row. A nil queue is a
// wiring bug (500); a store failure maps through FromError.
func (s *Service) ResolveVendorRegistration(ctx context.Context, vendorUserID domain.UUID, approved bool) error {
	if s.notices == nil {
		return domain.FromError(errUnwired)
	}
	status := domain.VendorRegistrationRejected
	if approved {
		status = domain.VendorRegistrationApproved
	}
	if err := s.notices.Resolve(ctx, vendorUserID, status); err != nil {
		return domain.FromError(err)
	}
	return nil
}
