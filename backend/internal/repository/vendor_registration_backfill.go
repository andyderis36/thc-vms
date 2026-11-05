package repository

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

// BackfillVendorRegistrationNotices inserts one queue row per existing
// pending vendor account that has none yet, so vendor accounts created
// before migration 000020 existed appear in the superadmin approval queue
// (GET /notifications/pending-registrations).
//
// It is idempotent: the SELECT covers only pending vendor users and every
// insert rides ON CONFLICT (vendor_user_id) DO NOTHING on the UNIQUE anchor,
// so a second run inserts 0 rows and an interrupted run resumes safely.
// Returns the number of rows inserted by this run.
//
// Run order per binding design: migrate up -> deploy backend -> backfill ->
// enable email. The backfill writes rows only and never sends email; email
// belongs to the live registration flow.
//
// Predicates mirror the live path: role name 'vendor' (domain.RoleVendor,
// seeded by the backend seeder) and account status 'pending'
// (domain.UserStatusPending, migration 000018). There is no generated sqlc
// adapter for vendor_registration_notices yet, hence direct SQL.
func BackfillVendorRegistrationNotices(ctx context.Context, pool *pgxpool.Pool) (int64, error) {
	tag, err := pool.Exec(ctx, `INSERT INTO vendor_registration_notices (vendor_user_id)
		SELECT u.id FROM users u
		JOIN role r ON r.id = u.role_id
		WHERE r.name = 'vendor' AND u.status = 'pending'
		ON CONFLICT (vendor_user_id) DO NOTHING`)
	if err != nil {
		return 0, MapError(err)
	}
	return tag.RowsAffected(), nil
}
