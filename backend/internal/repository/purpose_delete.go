package repository

import (
	"context"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/repository/db"
)

// Compile-time proof that the same PostgreSQL adapter satisfies the delete
// half of the super_admin purpose port.
var (
	_ domain.PurposeAdminRepository = (*masterRepository)(nil)
)

// CountVisitsByPurpose reports visit_purpose links still pointing at the
// catalogue row. It is the DELETE /purposes/:id pre-check: non-zero refuses
// with 409.
func (r *masterRepository) CountVisitsByPurpose(ctx context.Context, purposeID domain.UUID) (int64, error) {
	parsed, err := fromDomainUUID(purposeID)
	if err != nil {
		return 0, err
	}
	n, err := db.New(r.pool).CountVisitsByPurpose(ctx, db.CountVisitsByPurposeParams{PurposeID: parsed})
	if err != nil {
		return 0, MapError(err)
	}
	return n, nil
}

// DeletePurpose removes one catalogue purpose row for DELETE /purposes/:id.
// Missing is domain.ErrNotFound via pgx.ErrNoRows; a raced reference is
// domain.ErrConflict via the 23503 mapping.
func (r *masterRepository) DeletePurpose(ctx context.Context, id domain.UUID) error {
	parsed, err := fromDomainUUID(id)
	if err != nil {
		return err
	}
	if _, err := db.New(r.pool).DeletePurpose(ctx, db.DeletePurposeParams{ID: parsed}); err != nil {
		return MapError(err)
	}
	return nil
}
