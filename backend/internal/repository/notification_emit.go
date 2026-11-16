package repository

import (
	"context"
	"time"

	"github.com/google/uuid"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/repository/db"
)

// emit writes the notification rows for one visit event through q, which is
// either the caller's open transaction (lifecycle writes) or the pool (the
// reminder worker). A nil template - a status move that produces no notice - is
// a no-op, so callers can pass TransitionNotification's result unconditionally.
//
// Recipients are resolved in SQL by audience: vendor targets the visit's vendor user,
// staff fans out to the national super_admin plus the branch admin/security,
// except visit_requested which fans out to super_admin plus the branch admin
// only (no security): the new-request bell is for approvers, matching the
// admin-only email leg in enqueueCreateEmail.
// Duplicate inserts collapse on the (user_id, type, visit_request_id) unique
// constraint, making re-emission (retries, backfill) idempotent.
func emit(
	ctx context.Context,
	q *db.Queries,
	tpl *domain.NotificationTemplate,
	visitRequestID uuid.UUID,
	locationID uuid.UUID,
	vendorUserID uuid.UUID,
	at time.Time,
	snap domain.NotificationSettings,
) error {
	if tpl == nil {
		return nil
	}
	if !snap.IsInAppEnabled(tpl.Type, tpl.Audience) {
		return nil
	}
	switch tpl.Audience {
	case domain.NotificationAudienceVendor:
		return MapError(q.InsertVendorNotification(ctx, db.InsertVendorNotificationParams{
			VisitRequestID: visitRequestID,
			Type:           string(tpl.Type),
			Title:          tpl.Title,
			Message:        tpl.Message,
			CreatedAt:      at,
			VendorUserID:   vendorUserID,
		}))
	case domain.NotificationAudienceStaff:
		if tpl.Type == domain.NotificationVisitRequested {
			return MapError(q.InsertAdminNotifications(ctx, db.InsertAdminNotificationsParams{
				VisitRequestID: visitRequestID,
				Type:           string(tpl.Type),
				Title:          tpl.Title,
				Message:        tpl.Message,
				CreatedAt:      at,
				LocationID:     locationID,
			}))
		}
		return MapError(q.InsertStaffNotifications(ctx, db.InsertStaffNotificationsParams{
			VisitRequestID: visitRequestID,
			Type:           string(tpl.Type),
			Title:          tpl.Title,
			Message:        tpl.Message,
			CreatedAt:      at,
			LocationID:     locationID,
		}))
	default:
		return nil
	}
}
