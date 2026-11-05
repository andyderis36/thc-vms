package domain

import (
	"context"
	"time"
)

// This file owns the VENDOR REGISTRATION NOTICE queue (migration 000020).
// Public self-registration (POST /auth/register, migration 000018) creates
// vendor accounts with status pending; each one gains exactly one row here,
// resolved when a superadmin approves or rejects the account
// (PATCH /users/:id/status). The row is the durable state behind
// GET /notifications/pending-registrations and the superadmin approval bell.
//
// The domain layer contributes the row, the read shape, the persistence port
// and the staff email subject. Later waves build the sqlc adapter, the
// superadmin-only usecase fan-out (async best-effort email) and the frontend
// bell entry on top of this contract; nothing here is SQL- or HTTP-aware.

// VendorRegistrationStatus is the closed queue vocabulary pinned by
// migration 000020 (chk_vendor_registration_notices_status).
type VendorRegistrationStatus string

const (
	VendorRegistrationPending  VendorRegistrationStatus = "pending"
	VendorRegistrationApproved VendorRegistrationStatus = "approved"
	VendorRegistrationRejected VendorRegistrationStatus = "rejected"
)

// VendorRegistrationNotice is one queue row: the pending vendor account plus
// its resolution state. ResolvedAt is nil while the notice is pending.
type VendorRegistrationNotice struct {
	ID           UUID
	VendorUserID UUID
	Status       VendorRegistrationStatus
	ResolvedAt   *time.Time
	CreatedAt    time.Time
}

// PendingVendorRegistration is the queue read shape served to superadmins
// (docs/4. openapi.yaml PendingRegistrationItem): the vendor account joined
// onto its notice, so the approval screen renders without a second hop.
type PendingVendorRegistration struct {
	VendorUserID UUID
	Name         string
	Email        string
	Phone        string
	NIK          string
	VendorName   string
	CreatedAt    time.Time
	Status       VendorRegistrationStatus
}

// VendorRegistrationNoticeRepository is the persistence port. InsertPending
// is idempotent through the store's UNIQUE(vendor_user_id) anchor: repeat
// calls for the same vendor are ON CONFLICT DO NOTHING and never touch the
// first row. Resolve flips one notice to approved/rejected and stamps
// resolved_at; ListPending serves the newest pending rows first with the
// bell count.
type VendorRegistrationNoticeRepository interface {
	InsertPending(ctx context.Context, vendorUserID UUID) error
	ListPending(ctx context.Context, page, limit int) (items []PendingVendorRegistration, total, pendingCount int64, err error)
	Resolve(ctx context.Context, vendorUserID UUID, status VendorRegistrationStatus) error
}

// VendorRegistrationSubject renders the locked staff email subject for a new
// vendor registration, in the mailer.go table style ("[THC-VMS] <Judul> —
// <identifier>"): the identifier is the vendor name when known, else the
// registration email. Subjects are never empty: a blank identifier falls
// back to the bare title line.
func VendorRegistrationSubject(nameOrEmail string) string {
	const title = "[THC-VMS] Pendaftaran Vendor Baru"
	if nameOrEmail == "" {
		return title
	}
	return title + " — " + nameOrEmail
}
