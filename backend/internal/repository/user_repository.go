package repository

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/repository/db"
)

// userRepository is the PostgreSQL adapter for domain.UserRepository. Every
// read and write goes through the generated db.Querier; no SQL is hand-written
// here.
type userRepository struct {
	pool *pgxpool.Pool
}

// Compile-time proof that the adapter satisfies its port.
var _ domain.UserRepository = (*userRepository)(nil)

// NewUserRepository builds the PostgreSQL-backed domain.UserRepository.
func NewUserRepository(pool *pgxpool.Pool) domain.UserRepository {
	return &userRepository{pool: pool}
}

// queries returns the pool-scoped generated query set.
func (r *userRepository) queries() *db.Queries {
	return db.New(r.pool)
}

// FindByEmail resolves the login projection by email address. A missing row
// becomes domain.ErrNotFound so the auth caller maps it to 401.
func (r *userRepository) FindByEmail(ctx context.Context, email string) (domain.User, error) {
	row, err := r.queries().GetUserByEmailForLogin(ctx, db.GetUserByEmailForLoginParams{Email: email})
	if err != nil {
		return domain.User{}, MapError(err)
	}
	return loginRowToUser(row), nil
}

// FindByID resolves the profile projection by primary key.
func (r *userRepository) FindByID(ctx context.Context, id domain.UUID) (domain.User, error) {
	parsed, err := fromDomainUUID(id)
	if err != nil {
		return domain.User{}, err
	}
	row, err := r.queries().GetUserByID(ctx, db.GetUserByIDParams{ID: parsed})
	if err != nil {
		return domain.User{}, MapError(err)
	}
	return profileRowToUser(row), nil
}

// Create persists a branch security account. The only generated user INSERT is
// InsertSecurityUser (type 'internal', status 'active'), which is exactly the
// POST /users/security path this port serves in the MVP.
func (r *userRepository) Create(ctx context.Context, user domain.User) (domain.User, error) {
	roleID, err := fromDomainUUID(user.RoleID)
	if err != nil {
		return domain.User{}, err
	}
	locationID, err := pgNullUUIDPtr(user.LocationID)
	if err != nil {
		return domain.User{}, err
	}
	row, err := r.queries().InsertSecurityUser(ctx, db.InsertSecurityUserParams{
		Name:         user.Name,
		Email:        user.Email,
		PasswordHash: user.PasswordHash,
		Phone:        pgText(phonePtr(user.Phone)),
		RoleID:       roleID,
		LocationID:   locationID,
	})
	if err != nil {
		return domain.User{}, MapError(err)
	}
	return domain.User{
		ID:           mustDomainUUID(row.ID),
		Name:         row.Name,
		Email:        row.Email,
		PasswordHash: user.PasswordHash,
		Phone:        textValue(row.Phone),
		RoleID:       mustDomainUUID(row.RoleID),
		LocationID:   domainUUIDPtr(row.LocationID),
		Type:         domain.UserType(row.Type),
		Status:       domain.UserStatus(row.Status),
		CreatedAt:    row.CreatedAt,
		UpdatedAt:    row.UpdatedAt,
	}, nil
}

// UpdateStatus flips an account between active and inactive. The database
// CHECK additionally refuses values outside the account vocabulary.
func (r *userRepository) UpdateStatus(ctx context.Context, id domain.UUID, status domain.UserStatus) error {
	parsed, err := fromDomainUUID(id)
	if err != nil {
		return err
	}
	_, err = r.queries().UpdateUserStatus(ctx, db.UpdateUserStatusParams{
		ID:     parsed,
		Status: string(status),
	})
	if err != nil {
		return MapError(err)
	}
	return nil
}

// UpdateLastLogin stamps a successful authentication. The generated statement
// uses now() server-side, so the at instant documents the call but the clock
// stays with the database; a failure here must never fail the login itself,
// so callers log and continue.
func (r *userRepository) UpdateLastLogin(ctx context.Context, id domain.UUID, _ time.Time) error {
	parsed, err := fromDomainUUID(id)
	if err != nil {
		return err
	}
	if err := r.queries().UpdateUserLastLogin(ctx, db.UpdateUserLastLoginParams{ID: parsed}); err != nil {
		return MapError(err)
	}
	return nil
}

// ListSecurity returns the gate staff of one branch, or of every branch when
// locationID is nil (super_admin only). The branch predicate lives in the
// generated query as a bound parameter, never in Go string code.
func (r *userRepository) ListSecurity(ctx context.Context, locationID *domain.UUID) ([]domain.User, error) {
	scope, err := pgNullUUIDPtr(locationID)
	if err != nil {
		return nil, err
	}
	rows, err := r.queries().ListSecurityUsers(ctx, db.ListSecurityUsersParams{LocationID: scope})
	if err != nil {
		return nil, MapError(err)
	}
	out := make([]domain.User, 0, len(rows))
	for _, row := range rows {
		out = append(out, securityRowToUser(row))
	}
	return out, nil
}

// loginRowToUser projects the auth lookup onto the domain account.
//
// KNOWN GAP (generated shape vs port): GetUserByEmailForLogin returns the
// role NAME but no role_id, and no created_at/updated_at/last_login columns,
// so User.RoleID stays empty and the audit timestamps stay zero here. Adding
// u.role_id, u.created_at, u.updated_at and u.last_login to that SELECT would
// close the gap without touching Go code.
// loginRowToUser maps the login row onto the domain entity. RoleID is carried
// even though the row also exposes the resolved role NAME: the JWT directory
// and the profile projection both resolve a role from its id, so dropping it
// here made every login fail with 401 at token-minting time.
func loginRowToUser(row db.GetUserByEmailForLoginRow) domain.User {
	return domain.User{
		ID:           mustDomainUUID(row.ID),
		Name:         row.Name,
		Email:        row.Email,
		PasswordHash: row.PasswordHash,
		Phone:        textValue(row.Phone),
		RoleID:       mustDomainUUID(row.RoleID),
		LocationID:   domainUUIDPtr(row.LocationID),
		Type:         domain.UserType(row.Type),
		Status:       domain.UserStatus(row.Status),
		VendorID:     domainUUIDPtr(row.VendorID),
	}
}

// profileRowToUser projects the GET /auth/me read onto the domain account.
// Same role_id gap as loginRowToUser; created_at IS present on this row.
func profileRowToUser(row db.GetUserByIDRow) domain.User {
	return domain.User{
		ID:         mustDomainUUID(row.ID),
		Name:       row.Name,
		Email:      row.Email,
		Phone:      textValue(row.Phone),
		RoleID:     mustDomainUUID(row.RoleID),
		LocationID: domainUUIDPtr(row.LocationID),
		Type:       domain.UserType(row.Type),
		Status:     domain.UserStatus(row.Status),
		VendorID:   domainUUIDPtr(row.VendorID),
		CreatedAt:  row.CreatedAt,
	}
}

// securityRowToUser projects one branch security account. Same role_id gap.
func securityRowToUser(row db.ListSecurityUsersRow) domain.User {
	return domain.User{
		ID:         mustDomainUUID(row.ID),
		Name:       row.Name,
		Email:      row.Email,
		Phone:      textValue(row.Phone),
		LocationID: domainUUIDPtr(row.LocationID),
		Type:       domain.UserType(row.Type),
		Status:     domain.UserStatus(row.Status),
		VendorID:   domainUUIDPtr(row.VendorID),
		CreatedAt:  row.CreatedAt,
	}
}

// phonePtr maps the domain phone string to the optional form convert helpers
// expect: empty means absent, never an empty-string phone row.
func phonePtr(phone string) *string {
	if phone == "" {
		return nil
	}
	return &phone
}

// textValue renders a nullable text column as a plain string, NULL as "".
func textValue(t pgtype.Text) string {
	if !t.Valid {
		return ""
	}
	return t.String
}
