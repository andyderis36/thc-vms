package repository

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/repository/db"
)

// BackfillNotifications replays the visit lifecycle history into the
// notification store for rows created before it existed, so existing visits
// appear in every recipient's feed. It is idempotent: other types ride the
// ON CONFLICT no-op branch, and rescheduled replays carry older timestamps
// than the live rows so the newer-wins guard leaves them untouched - a
// second run leaves the row count and content unchanged.
// Returns the number of source events examined.
func BackfillNotifications(ctx context.Context, pool *pgxpool.Pool) (int, error) {
	q := db.New(pool)
	rows, err := q.ListBackfillNotificationEvents(ctx)
	if err != nil {
		return 0, MapError(err)
	}
	for _, row := range rows {
		if err := emit(ctx, q, backfillTemplate(row), row.VisitRequestID, row.LocationID, row.VendorUserID, row.OccurredAt); err != nil {
			return 0, err
		}
	}
	return len(rows), nil
}

// backfillTemplate maps one history event onto the same template the live write
// path would have produced at the time, so a backfilled row is byte-identical to
// a live one. Events with no notice (e.g. a manual cancel, an auto-complete)
// map to nil and are skipped.
func backfillTemplate(row db.ListBackfillNotificationEventsRow) *domain.NotificationTemplate {
	switch row.Source {
	case "requested":
		return domain.CreatedNotification(row.VisitID)
	case "check_in":
		return domain.TransitionNotification(domain.VisitStatusVisiting, false, row.VisitID, "")
	case "check_out":
		return domain.TransitionNotification(domain.VisitStatusCompleted, false, row.VisitID, "")
	case "status":
		// Reason-free on purpose: backfill rows keep the legacy message
		// (status_history notes are not replayed into the bell).
		return domain.TransitionNotification(domain.VisitStatus(row.Status), row.IsSystem, row.VisitID, "")
	default:
		return nil
	}
}
