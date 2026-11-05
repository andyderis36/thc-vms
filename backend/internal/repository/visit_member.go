package repository

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/repository/db"
)

// UpdateVisitorContact corrects one roster member's phone number and its
// persistent edited marker in ONE transaction: lock via
// GetVisitorByIDForUpdate, write via UpdateVisitorContact. The caller passes
// the fully resolved value AND the resolved flag (read-modify-write); the
// adapter stores it with a monotonic OR so a repeated correction can never
// clear a flag this write sets.
//
// A visitor that does not belong to visitID answers ErrNotFound, exactly like
// a missing id: the endpoint must not reveal whether the member lives under
// another visit.
func (r *visitRepository) UpdateVisitorContact(
	ctx context.Context,
	visitID domain.UUID,
	visitorID domain.UUID,
	phone string,
	phoneEdited bool,
) (domain.Visitor, error) {
	visitParsed, err := fromDomainUUID(visitID)
	if err != nil {
		return domain.Visitor{}, err
	}
	parsed, err := fromDomainUUID(visitorID)
	if err != nil {
		return domain.Visitor{}, err
	}
	var updated domain.Visitor
	if err := WithTx(ctx, r.pool, func(tx pgx.Tx) error {
		q := db.New(r.pool).WithTx(tx)
		locked, err := q.GetVisitorByIDForUpdate(ctx, db.GetVisitorByIDForUpdateParams{ID: parsed})
		if err != nil {
			return MapError(err)
		}
		if locked.VisitRequestID != visitParsed {
			return fmt.Errorf("repository: visitor %s not under visit %s: %w", visitorID, visitID, domain.ErrNotFound)
		}
		row, err := q.UpdateVisitorContact(ctx, db.UpdateVisitorContactParams{
			ID:          parsed,
			Phone:       phone,
			PhoneEdited: phoneEdited,
		})
		if err != nil {
			return MapError(err)
		}
		// The UPDATE RETURNING carries no vendor join; the display name rides
		// along from the locked row read in the same transaction, so the
		// corrected roster entry renders exactly like a list/detail one.
		updated = dbVisitorToDomain(row, locked.VendorName)
		return nil
	}); err != nil {
		return domain.Visitor{}, err
	}
	return updated, nil
}
