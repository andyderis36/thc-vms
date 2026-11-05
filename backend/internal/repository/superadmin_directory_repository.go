package repository

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"

	"thc-vms/backend/internal/repository/db"
)

// superAdminDirectoryRepository is the PostgreSQL adapter behind the vendor
// registration email fan-out: every ACTIVE account holding the super_admin or
// the hidden dev-superadmin role, ordered by email. There is deliberately NO
// location predicate and NO admin/security roles (a national queue, not a
// visit at one branch). The interface is satisfied structurally so this
// package never imports the auth usecase.
type superAdminDirectoryRepository struct {
	pool *pgxpool.Pool
}

// NewSuperAdminDirectoryRepository builds the PostgreSQL-backed superadmin
// email directory.
func NewSuperAdminDirectoryRepository(pool *pgxpool.Pool) *superAdminDirectoryRepository {
	return &superAdminDirectoryRepository{pool: pool}
}

// ListSuperAdminEmails resolves the active superadmin recipient set for one
// registration notice. An empty set is normal (no active superadmin) and
// never an error; the caller skips the mail leg and keeps the queue row.
func (r *superAdminDirectoryRepository) ListSuperAdminEmails(ctx context.Context) ([]string, error) {
	emails, err := db.New(r.pool).ListSuperAdminEmails(ctx)
	if err != nil {
		return nil, MapError(err)
	}
	return emails, nil
}
