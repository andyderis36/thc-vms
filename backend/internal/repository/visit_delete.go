package repository

import (
	"context"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/repository/db"
)

// Compile-time proof that the same PostgreSQL adapter satisfies the extended
// visit port (the delete half of the super_admin purge path).
var (
	_ domain.VisitRepository = (*visitRepository)(nil)
)

// DeleteVisit removes one visit row for DELETE /visits/:id (super_admin
// only, any status). The child tables (visitor, visit_purpose,
// status_history, check_in, check_out) all carry ON DELETE CASCADE, so the
// single-row delete cleans the roster, purposes, history and gate records
// atomically. A missing id surfaces domain.ErrNotFound through MapError's
// pgx.ErrNoRows mapping, which the handler renders as 404.
func (r *visitRepository) DeleteVisit(ctx context.Context, id domain.UUID) error {
	parsed, err := fromDomainUUID(id)
	if err != nil {
		return err
	}
	if _, err := db.New(r.pool).DeleteVisit(ctx, db.DeleteVisitParams{ID: parsed}); err != nil {
		return MapError(err)
	}
	return nil
}
