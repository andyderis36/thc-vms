package repository

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/repository/db"
)

// vendorRegistrationNoticeRepository is the PostgreSQL adapter for
// domain.VendorRegistrationNoticeRepository (migration 000020). It owns only
// the notices queue: recipient fan-out stays in notifications.sql and the
// dev-superadmin parity predicate there is deliberately not duplicated here.
type vendorRegistrationNoticeRepository struct {
	pool *pgxpool.Pool
}

var _ domain.VendorRegistrationNoticeRepository = (*vendorRegistrationNoticeRepository)(nil)

// NewVendorRegistrationNoticeRepository builds the PostgreSQL-backed
// domain.VendorRegistrationNoticeRepository.
func NewVendorRegistrationNoticeRepository(pool *pgxpool.Pool) domain.VendorRegistrationNoticeRepository {
	return &vendorRegistrationNoticeRepository{pool: pool}
}

// InsertPending queues one pending vendor account. The insert carries
// ON CONFLICT (vendor_user_id) DO NOTHING, so a retry for the same vendor
// affects zero rows and leaves the first row untouched.
func (r *vendorRegistrationNoticeRepository) InsertPending(ctx context.Context, vendorUserID domain.UUID) error {
	parsed, err := requireVendorUserID(vendorUserID)
	if err != nil {
		return err
	}
	return MapError(db.New(r.pool).InsertPendingVendorRegistrationNotice(ctx,
		db.InsertPendingVendorRegistrationNoticeParams{VendorUserID: parsed}))
}

// Resolve flips one pending notice to approved/rejected and stamps
// resolved_at. The pending guard in SQL makes a repeated decision a no-op
// success; resolving back to pending is rejected here so a row can never
// carry a resolved_at stamp while pending.
func (r *vendorRegistrationNoticeRepository) Resolve(ctx context.Context, vendorUserID domain.UUID, status domain.VendorRegistrationStatus) error {
	if status != domain.VendorRegistrationApproved && status != domain.VendorRegistrationRejected {
		return fmt.Errorf("repository: invalid registration resolution %q: %w", status, domain.ErrValidation)
	}
	parsed, err := requireVendorUserID(vendorUserID)
	if err != nil {
		return err
	}
	_, err = db.New(r.pool).ResolveVendorRegistrationNotice(ctx,
		db.ResolveVendorRegistrationNoticeParams{VendorUserID: parsed, Status: string(status)})
	return MapError(err)
}

// ListPending serves one page of the superadmin approval queue, newest first,
// plus the companion bell count. The queue holds only pending notices, so
// total and pendingCount are the same number; both are returned because the
// port mirrors the notification list shape ({items,total} plus the badge).
// Page/Limit arrive already clamped by the caller; this is the final
// defensive bound on the pending-registrations wire contract (default 20,
// max 100, the notification pagination shape openapi pins for the bell).
func (r *vendorRegistrationNoticeRepository) ListPending(ctx context.Context, page, limit int) ([]domain.PendingVendorRegistration, int64, int64, error) {
	if page < 1 {
		page = 1
	}
	if limit < 1 {
		limit = domain.DefaultNotificationPageSize
	}
	if limit > domain.MaxNotificationPageSize {
		limit = domain.MaxNotificationPageSize
	}
	offset := int32((page - 1) * limit)

	q := db.New(r.pool)
	rows, err := q.ListPendingVendorRegistrations(ctx, db.ListPendingVendorRegistrationsParams{
		Offset: offset,
		Limit:  int32(limit),
	})
	if err != nil {
		return nil, 0, 0, MapError(err)
	}
	pending, err := q.CountPendingVendorRegistrationNotices(ctx)
	if err != nil {
		return nil, 0, 0, MapError(err)
	}

	out := make([]domain.PendingVendorRegistration, 0, len(rows))
	for _, row := range rows {
		out = append(out, domain.PendingVendorRegistration{
			VendorUserID: mustDomainUUID(row.VendorUserID),
			Name:         row.Name,
			Email:        row.Email,
			// NULL phone/nik render as "" on the wire (openapi phone/nik
			// are plain strings, never null).
			Phone: row.Phone.String,
			NIK:   row.Nik.String,
			// Manual company text wins over the catalogue name, "" when
			// neither exists (resolveVendorDisplayName, never NULL).
			VendorName: resolveVendorDisplayName(row.VendorNameOverride, row.VendorName),
			CreatedAt:  row.CreatedAt,
			Status:     domain.VendorRegistrationStatus(row.Status),
		})
	}
	return out, pending, pending, nil
}

// requireVendorUserID parses the notice key. The empty string means "no
// account" and yields the zero UUID, which the FK would reject as a conflict;
// it is a caller bug, so it fails here as validation instead.
func requireVendorUserID(vendorUserID domain.UUID) (uuid.UUID, error) {
	if vendorUserID == "" {
		return uuid.Nil, fmt.Errorf("repository: missing vendor user id: %w", domain.ErrValidation)
	}
	return fromDomainUUID(vendorUserID)
}
