package repository

import (
	"context"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/repository/db"
)

// Compile-time proof that the same PostgreSQL adapter satisfies the delete
// half of the super_admin account port.
var (
	_ domain.ManagedUserRepository = (*userRepository)(nil)
)

// CountVisitsByVendorUser reports how many visits the account still owns as vendor.
// It is the first DELETE /users/:id pre-check: a non-zero count refuses
// with 409 before any write is attempted.
func (r *userRepository) CountVisitsByVendorUser(ctx context.Context, userID domain.UUID) (int64, error) {
	parsed, err := fromDomainUUID(userID)
	if err != nil {
		return 0, err
	}
	n, err := r.queries().CountVisitsByVendorUser(ctx, db.CountVisitsByVendorUserParams{VendorUserID: parsed})
	if err != nil {
		return 0, MapError(err)
	}
	return n, nil
}

// CountStaffReferences reports how many gate/audit rows the account wrote as
// staff (check-in + check-out + status history). Non-zero refuses with 409.
func (r *userRepository) CountStaffReferences(ctx context.Context, userID domain.UUID) (int64, error) {
	parsed, err := fromDomainUUID(userID)
	if err != nil {
		return 0, err
	}
	n, err := r.queries().CountStaffReferences(ctx, db.CountStaffReferencesParams{CheckedInBy: parsed})
	if err != nil {
		return 0, MapError(err)
	}
	return int64(n), nil
}

// DeleteUser removes one account row for DELETE /users/:id. A missing id
// surfaces domain.ErrNotFound through MapError's pgx.ErrNoRows mapping; a
// reference that raced the pre-checks surfaces domain.ErrConflict through
// the 23503 mapping, which the handler renders as 409.
func (r *userRepository) DeleteUser(ctx context.Context, id domain.UUID) error {
	parsed, err := fromDomainUUID(id)
	if err != nil {
		return err
	}
	if _, err := r.queries().DeleteUser(ctx, db.DeleteUserParams{ID: parsed}); err != nil {
		return MapError(err)
	}
	return nil
}
