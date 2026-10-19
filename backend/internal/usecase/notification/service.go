package notification

import (
	"context"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/visit"
)

// Actor is the authenticated caller behind a notification request. It reuses
// the visit usecase actor type verbatim so handlers and tests share one identity.
type Actor = visit.Actor

// ListNotificationsInput carries the caller-supplied listing knobs.
type ListNotificationsInput struct {
	Page       int
	Limit      int
	LocationID *domain.UUID
}

// Backwards-compatible aliases for callers/tests that use shorter names.
type ListInput = ListNotificationsInput
type NotificationsInput = ListNotificationsInput

// ListNotificationsResult is one scoped page plus its companion counts. UnreadCount
// is the caller's global unread total (unaffected by the location filter) and
// drives the bell badge; Total is the filtered row count behind Items.
type ListNotificationsResult struct {
	Items       []domain.Notification
	Total       int64
	UnreadCount int64
	Page        int
	Limit       int
}

// Service is the notification usecase.
type Service struct {
	notifications domain.NotificationRepository
}

// NewService wires the usecase to its repository port.
func NewService(repo domain.NotificationRepository) *Service {
	return &Service{notifications: repo}
}

// List applies branch scoping and returns one page, the filtered total and the
// caller's global unread count. admin/security are locked to their own branch;
// super_admin may narrow nationally by location_id; vendor sees only its own
// notifications regardless of location.
func (s *Service) List(ctx context.Context, actor Actor, in ListNotificationsInput) (ListNotificationsResult, error) {
	page := in.Page
	if page < 1 {
		page = 1
	}
	limit := in.Limit
	if limit < 1 || limit > domain.MaxNotificationPageSize {
		limit = domain.DefaultNotificationPageSize
	}

	filter := domain.NotificationFilter{
		UserID: actor.ID,
		Page:   page,
		Limit:  limit,
	}
	switch actor.Role {
	case domain.RoleAdmin, domain.RoleSecurity:
		filter.LocationID = actor.LocationID
	case domain.RoleSuperAdmin:
		filter.LocationID = in.LocationID
	case domain.RoleVendor:
		filter.LocationID = nil
	default:
		return ListNotificationsResult{}, domain.ForbiddenBranch()
	}

	items, total, unread, err := s.notifications.List(ctx, filter)
	if err != nil {
		return ListNotificationsResult{}, err
	}
	return ListNotificationsResult{
		Items:       items,
		Total:       total,
		UnreadCount: unread,
		Page:        page,
		Limit:       limit,
	}, nil
}

// MarkRead marks one notification owned by the caller read. An id that belongs
// to another user (or does not exist) matches no row and becomes ErrNotFound, so
// a caller can never confirm or flip somebody else's notice.
func (s *Service) MarkRead(ctx context.Context, actor Actor, id domain.UUID) error {
	ok, err := s.notifications.MarkRead(ctx, id, actor.ID)
	if err != nil {
		return err
	}
	if !ok {
		return domain.NotFoundEntity("Notifikasi")
	}
	return nil
}

// MarkAllRead marks every unread notification of the caller read and returns the
// number of rows changed.
func (s *Service) MarkAllRead(ctx context.Context, actor Actor) (int64, error) {
	return s.notifications.MarkAllRead(ctx, actor.ID)
}
