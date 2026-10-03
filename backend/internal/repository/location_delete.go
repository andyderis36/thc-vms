package repository

import (
	"context"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/repository/db"
)

// Compile-time proof that the same PostgreSQL adapter satisfies the delete
// half of the super_admin facility port.
var (
	_ domain.LocationAdminRepository = (*masterRepository)(nil)
)

// CountUsersByLocation reports accounts stationed at the facility. It is the
// first DELETE /locations/:id pre-check: non-zero refuses with 409.
func (r *masterRepository) CountUsersByLocation(ctx context.Context, locationID domain.UUID) (int64, error) {
	parsed, err := fromDomainUUID(locationID)
	if err != nil {
		return 0, err
	}
	scope, err := pgNullUUID(domain.UUID(parsed.String()))
	if err != nil {
		return 0, err
	}
	n, err := db.New(r.pool).CountUsersByLocation(ctx, db.CountUsersByLocationParams{
		LocationID: scope,
	})
	if err != nil {
		return 0, MapError(err)
	}
	return n, nil
}

// CountVisitsByLocation reports visits hosted at the facility. Non-zero
// refuses the delete with 409.
func (r *masterRepository) CountVisitsByLocation(ctx context.Context, locationID domain.UUID) (int64, error) {
	parsed, err := fromDomainUUID(locationID)
	if err != nil {
		return 0, err
	}
	n, err := db.New(r.pool).CountVisitsByLocation(ctx, db.CountVisitsByLocationParams{LocationID: parsed})
	if err != nil {
		return 0, MapError(err)
	}
	return n, nil
}

// DeleteLocation removes one facility row for DELETE /locations/:id. Missing
// is domain.ErrNotFound via pgx.ErrNoRows; a raced reference is
// domain.ErrConflict via the 23503 mapping.
func (r *masterRepository) DeleteLocation(ctx context.Context, id domain.UUID) error {
	parsed, err := fromDomainUUID(id)
	if err != nil {
		return err
	}
	if _, err := db.New(r.pool).DeleteLocation(ctx, db.DeleteLocationParams{ID: parsed}); err != nil {
		return MapError(err)
	}
	return nil
}
