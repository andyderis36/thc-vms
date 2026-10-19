package repository

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/repository/db"
)

// notificationRepository is the PostgreSQL adapter for domain.NotificationRepository.
type notificationRepository struct {
	pool *pgxpool.Pool
}

var _ domain.NotificationRepository = (*notificationRepository)(nil)

// NewNotificationRepository builds the PostgreSQL-backed domain.NotificationRepository.
func NewNotificationRepository(pool *pgxpool.Pool) domain.NotificationRepository {
	return &notificationRepository{pool: pool}
}

// List serves one page of the user's own notifications plus the companion
// count and the user's GLOBAL unread count. LocationID nil means every branch
// (super_admin national view / vendor); non-nil narrows a super_admin's feed to
// one branch. The unread count is intentionally unfiltered by location so the
// bell badge never misreports how many notices are still unread anywhere.
func (r *notificationRepository) List(ctx context.Context, filter domain.NotificationFilter) ([]domain.Notification, int64, int64, error) {
	// Page/Limit are documented to arrive already clamped by the usecase; this is
	// the final defensive bound. It uses the notification pagination contract
	// (default 20, max 100), NOT the visit-list helper whose default is 10.
	page, limit := filter.Page, filter.Limit
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

	userID, err := fromDomainUUID(filter.UserID)
	if err != nil {
		return nil, 0, 0, err
	}
	loc, err := pgNullUUIDPtr(filter.LocationID)
	if err != nil {
		return nil, 0, 0, err
	}

	q := db.New(r.pool)
	rows, err := q.ListNotificationsForUser(ctx, db.ListNotificationsForUserParams{
		UserID:     userID,
		LocationID: loc,
		Offset:     offset,
		Limit:      int32(limit),
	})
	if err != nil {
		return nil, 0, 0, MapError(err)
	}
	total, err := q.CountNotificationsForUser(ctx, db.CountNotificationsForUserParams{
		UserID:     userID,
		LocationID: loc,
	})
	if err != nil {
		return nil, 0, 0, MapError(err)
	}
	unread, err := q.CountUnreadNotificationsForUser(ctx, db.CountUnreadNotificationsForUserParams{
		UserID: userID,
	})
	if err != nil {
		return nil, 0, 0, MapError(err)
	}

	out := make([]domain.Notification, 0, len(rows))
	for _, row := range rows {
		out = append(out, domain.Notification{
			ID:             mustDomainUUID(row.ID),
			Type:           domain.NotificationType(row.Type),
			VisitRequestID: mustDomainUUID(row.VisitRequestID),
			VisitID:        row.VisitID,
			LocationID:     mustDomainUUID(row.LocationID),
			LocationName:   row.LocationName,
			Title:          row.Title,
			Message:        row.Message,
			IsRead:         row.IsRead,
			OccurredAt:     row.OccurredAt,
		})
	}
	return out, total, unread, nil
}

// MarkRead flips one owned notification to read. A row owned by somebody else
// (or missing) affects zero rows and reports false so the caller answers 404.
func (r *notificationRepository) MarkRead(ctx context.Context, id, userID domain.UUID) (bool, error) {
	parsedID, err := fromDomainUUID(id)
	if err != nil {
		return false, err
	}
	parsedUser, err := fromDomainUUID(userID)
	if err != nil {
		return false, err
	}
	affected, err := db.New(r.pool).MarkNotificationRead(ctx, db.MarkNotificationReadParams{
		ID:     parsedID,
		UserID: parsedUser,
	})
	if err != nil {
		return false, MapError(err)
	}
	return affected > 0, nil
}

// MarkAllRead marks every unread notification of the user read and returns how
// many rows changed.
func (r *notificationRepository) MarkAllRead(ctx context.Context, userID domain.UUID) (int64, error) {
	parsedUser, err := fromDomainUUID(userID)
	if err != nil {
		return 0, err
	}
	affected, err := db.New(r.pool).MarkAllNotificationsRead(ctx, db.MarkAllNotificationsReadParams{
		UserID: parsedUser,
	})
	if err != nil {
		return 0, MapError(err)
	}
	return affected, nil
}

// InsertForVisit writes the notice for one visit, timestamped now. Used by the
// reminder worker; every lifecycle write inside a status transaction goes
// through emit instead so it shares that transaction. Nil template is a no-op.
func (r *notificationRepository) InsertForVisit(ctx context.Context, visit domain.VisitRequest, tpl *domain.NotificationTemplate) error {
	if tpl == nil {
		return nil
	}
	visitRequestID, err := fromDomainUUID(visit.ID)
	if err != nil {
		return err
	}
	locationID, err := fromDomainUUID(visit.LocationID)
	if err != nil {
		return err
	}
	vendorUserID, err := fromDomainUUID(visit.VendorUserID)
	if err != nil {
		return err
	}
	return emit(ctx, db.New(r.pool), tpl, visitRequestID, locationID, vendorUserID, time.Now())
}
