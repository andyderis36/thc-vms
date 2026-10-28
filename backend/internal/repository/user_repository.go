package repository

import (
	"context"
	"strings"
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

// Compile-time proof that the same adapter satisfies the super_admin managed
// account port (the status flip is the shared UpdateStatus method).
var _ domain.ManagedUserRepository = (*userRepository)(nil)

// Compile-time proof that the same adapter satisfies the self-service profile
// port.
var _ domain.ProfileRepository = (*userRepository)(nil)

// NewUserRepository builds the PostgreSQL-backed domain.UserRepository.
func NewUserRepository(pool *pgxpool.Pool) domain.UserRepository {
	return &userRepository{pool: pool}
}

// NewManagedUserRepository exposes the same PostgreSQL adapter through the
// super_admin managed-account port. It is a separate constructor (rather
// than a widened NewUserRepository return) so the security-account callers
// keep their narrow type and no existing signature changes.
func NewManagedUserRepository(pool *pgxpool.Pool) domain.ManagedUserRepository {
	return &userRepository{pool: pool}
}

// NewProfileRepository exposes the same PostgreSQL adapter through the
// self-service profile port. It is a separate constructor for the same reason
// NewManagedUserRepository is: existing callers keep their narrow type and no
// existing signature changes.
func NewProfileRepository(pool *pgxpool.Pool) domain.ProfileRepository {
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

// UpdateProfile stores the caller's own resolved profile fields and returns the
// refreshed row. An empty phone or avatar is written as SQL NULL (mirroring
// nikPtr); the generated statement re-reads the same joined projection as
// GetUserByID, so the row maps through profileRowToUser unchanged.
func (r *userRepository) UpdateProfile(ctx context.Context, id domain.UUID, update domain.ProfileUpdate) (domain.User, error) {
	parsed, err := fromDomainUUID(id)
	if err != nil {
		return domain.User{}, err
	}
	row, err := r.queries().UpdateUserProfile(ctx, db.UpdateUserProfileParams{
		ID:        parsed,
		Name:      update.Name,
		Phone:     pgText(phonePtr(update.Phone)),
		AvatarUrl: pgText(avatarPtr(update.AvatarURL)),
	})
	if err != nil {
		return domain.User{}, MapError(err)
	}
	// UpdateUserProfileRow and GetUserByIDRow are the same projection, so the
	// conversion keeps profileRowToUser the single source of row->domain.
	return profileRowToUser(db.GetUserByIDRow(row)), nil
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

// ListManagedUsers serves GET /users: every account matching the optional
// role, search and branch filters, with no pagination (consistent with
// ListSecurity). A blank search is sent as SQL NULL so the predicate is a
// no-op; every filter value travels as a bound parameter, never as
// interpolated SQL text.
func (r *userRepository) ListManagedUsers(ctx context.Context, filter domain.UserFilter) ([]domain.ManagedUser, error) {
	var role pgtype.Text
	if filter.Role != nil {
		role = pgtype.Text{String: string(*filter.Role), Valid: true}
	}
	var search pgtype.Text
	if trimmed := strings.TrimSpace(filter.Search); trimmed != "" {
		search = pgtype.Text{String: trimmed, Valid: true}
	}
	scope, err := pgNullUUIDPtr(filter.LocationID)
	if err != nil {
		return nil, err
	}
	rows, err := r.queries().ListManagedUsers(ctx, db.ListManagedUsersParams{
		Role:       role,
		Search:     search,
		LocationID: scope,
	})
	if err != nil {
		return nil, MapError(err)
	}
	out := make([]domain.ManagedUser, 0, len(rows))
	for _, row := range rows {
		out = append(out, managedListRowToUser(row))
	}
	return out, nil
}

// CreateManagedUser persists one admin or vendor account for POST /users. The
// caller sets RoleID, Type, Status, LocationID and VendorID after the
// usecase validation; the enforce_user_location_invariant trigger rejects
// any pairing the validation missed (check_violation -> ErrValidation via
// MapError) and users_email_key rejects a duplicate email (23505 ->
// ErrConflict via MapError, the same mapping POST /users/security relies
// on, rendered as 409 by the handler).
func (r *userRepository) CreateManagedUser(ctx context.Context, user domain.User) (domain.User, error) {
	roleID, err := fromDomainUUID(user.RoleID)
	if err != nil {
		return domain.User{}, err
	}
	locationID, err := pgNullUUIDPtr(user.LocationID)
	if err != nil {
		return domain.User{}, err
	}
	vendorID, err := pgNullUUIDPtr(user.VendorID)
	if err != nil {
		return domain.User{}, err
	}
	row, err := r.queries().InsertManagedUser(ctx, db.InsertManagedUserParams{
		Name:               user.Name,
		Email:              user.Email,
		PasswordHash:       user.PasswordHash,
		Phone:              pgText(phonePtr(user.Phone)),
		Nik:                pgText(nikPtr(user.NIK)),
		RoleID:             roleID,
		LocationID:         locationID,
		Type:               string(user.Type),
		Status:             string(user.Status),
		VendorID:           vendorID,
		VendorNameOverride: pgText(user.VendorNameOverride),
	})
	if err != nil {
		return domain.User{}, MapError(err)
	}
	return domain.User{
		ID:                 mustDomainUUID(row.ID),
		Name:               row.Name,
		Email:              row.Email,
		PasswordHash:       user.PasswordHash,
		Phone:              textValue(row.Phone),
		NIK:                textValue(row.Nik),
		RoleID:             mustDomainUUID(row.RoleID),
		LocationID:         domainUUIDPtr(row.LocationID),
		Type:               domain.UserType(row.Type),
		Status:             domain.UserStatus(row.Status),
		VendorID:           domainUUIDPtr(row.VendorID),
		VendorNameOverride: textPtr(row.VendorNameOverride),
		CreatedAt:          row.CreatedAt,
		UpdatedAt:          row.UpdatedAt,
	}, nil
}

// UpdateManagedUser applies a partial super_admin edit for PATCH /users/:id.
// Nil patch members keep the stored columns via COALESCE (patchMemberText /
// pgNullUUIDPtr render nil as SQL NULL); a duplicate email surfaces
// ErrConflict and a missing id ErrNotFound through MapError, the same
// mappings POST /users relies on.
func (r *userRepository) UpdateManagedUser(ctx context.Context, id domain.UUID, patch domain.ManagedUserPatch) (domain.User, error) {
	parsed, err := fromDomainUUID(id)
	if err != nil {
		return domain.User{}, err
	}
	locationID, err := pgNullUUIDPtr(patch.LocationID)
	if err != nil {
		return domain.User{}, err
	}
	vendorID, err := pgNullUUIDPtr(patch.VendorID)
	if err != nil {
		return domain.User{}, err
	}
	// Manual-company tri-state (migration 000005): nil keeps the stored
	// override (flag false), a blank value clears it to SQL NULL (flag true +
	// NULL value), a filled value sets it (flag true + text). A blank never
	// reaches patchMemberText, whose NULL-means-keep would make clearing
	// impossible through COALESCE.
	var (
		hasVendorOverride bool
		vendorOverride    pgtype.Text
	)
	if patch.VendorName != nil {
		hasVendorOverride = true
		if trimmed := strings.TrimSpace(*patch.VendorName); trimmed != "" {
			vendorOverride = pgtype.Text{String: trimmed, Valid: true}
		}
	}
	row, err := r.queries().UpdateManagedUser(ctx, db.UpdateManagedUserParams{
		Name:                  patchMemberText(patch.Name),
		Email:                 patchMemberText(patch.Email),
		Phone:                 patchMemberText(patch.Phone),
		Nik:                   patchMemberText(patch.NIK),
		LocationID:            locationID,
		VendorID:              vendorID,
		HasVendorNameOverride: hasVendorOverride,
		VendorNameOverride:    vendorOverride,
		PasswordHash:          patchMemberText(patch.PasswordHash),
		ID:                    parsed,
	})
	if err != nil {
		return domain.User{}, MapError(err)
	}
	return domain.User{
		ID:                 mustDomainUUID(row.ID),
		Name:               row.Name,
		Email:              row.Email,
		Phone:              textValue(row.Phone),
		NIK:                textValue(row.Nik),
		RoleID:             mustDomainUUID(row.RoleID),
		LocationID:         domainUUIDPtr(row.LocationID),
		Type:               domain.UserType(row.Type),
		Status:             domain.UserStatus(row.Status),
		VendorID:           domainUUIDPtr(row.VendorID),
		VendorNameOverride: textPtr(row.VendorNameOverride),
		CreatedAt:          row.CreatedAt,
		UpdatedAt:          row.UpdatedAt,
	}, nil
}

// FindManagedByID resolves one account with its joined role, location and
// vendor names for the super_admin console. A missing row becomes
// domain.ErrNotFound so the handler renders 404.
func (r *userRepository) FindManagedByID(ctx context.Context, id domain.UUID) (domain.ManagedUser, error) {
	parsed, err := fromDomainUUID(id)
	if err != nil {
		return domain.ManagedUser{}, err
	}
	row, err := r.queries().GetManagedUserByID(ctx, db.GetManagedUserByIDParams{ID: parsed})
	if err != nil {
		return domain.ManagedUser{}, MapError(err)
	}
	return domain.ManagedUser{
		User: domain.User{
			ID:                 mustDomainUUID(row.ID),
			Name:               row.Name,
			Email:              row.Email,
			Phone:              textValue(row.Phone),
			NIK:                textValue(row.Nik),
			RoleID:             mustDomainUUID(row.RoleID),
			LocationID:         domainUUIDPtr(row.LocationID),
			Type:               domain.UserType(row.Type),
			Status:             domain.UserStatus(row.Status),
			VendorID:           domainUUIDPtr(row.VendorID),
			VendorNameOverride: textPtr(row.VendorNameOverride),
			CreatedAt:          row.CreatedAt,
		},
		Role:         domain.RoleName(row.Role),
		LocationName: textPtr(row.LocationName),
		VendorName:   resolveVendorDisplayPtr(row.VendorNameOverride, row.VendorName),
	}, nil
}

// managedListRowToUser projects one listing row onto the console shape. The
// listing SELECT carries no role_id or password hash (neither is needed for
// the projection), so those members stay empty here; the detail read above
// carries them.
func managedListRowToUser(row db.ListManagedUsersRow) domain.ManagedUser {
	return domain.ManagedUser{
		User: domain.User{
			ID:                 mustDomainUUID(row.ID),
			Name:               row.Name,
			Email:              row.Email,
			Phone:              textValue(row.Phone),
			NIK:                textValue(row.Nik),
			AvatarURL:          textValue(row.AvatarUrl),
			LocationID:         domainUUIDPtr(row.LocationID),
			Type:               domain.UserType(row.Type),
			Status:             domain.UserStatus(row.Status),
			VendorID:           domainUUIDPtr(row.VendorID),
			VendorNameOverride: textPtr(row.VendorNameOverride),
			CreatedAt:          row.CreatedAt,
		},
		Role:         domain.RoleName(row.Role),
		LocationName: textPtr(row.LocationName),
		VendorName:   resolveVendorDisplayPtr(row.VendorNameOverride, row.VendorName),
	}
}

// loginRowToUser projects the auth lookup onto the domain account.
//
// KNOWN GAP (generated shape vs port): GetUserByEmailForLogin carries no
// created_at/updated_at/last_login columns, so those audit timestamps stay zero
// here. RoleID IS carried even though the row also exposes the resolved role
// NAME: the JWT directory and the profile projection both resolve a role from
// its id, so dropping it here made every login fail with 401 at token-minting
// time. AvatarURL is carried too: login feeds this user straight into the shared
// profile projection, which presigns it, so omitting the column made
// POST /auth/login answer avatar_url "" while GET /auth/me answered a valid
// presigned URL. Adding the remaining columns to that SELECT would close the
// gap without touching Go code.
func loginRowToUser(row db.GetUserByEmailForLoginRow) domain.User {
	return domain.User{
		ID:                 mustDomainUUID(row.ID),
		Name:               row.Name,
		Email:              row.Email,
		PasswordHash:       row.PasswordHash,
		Phone:              textValue(row.Phone),
		NIK:                textValue(row.Nik),
		AvatarURL:          textValue(row.AvatarUrl),
		RoleID:             mustDomainUUID(row.RoleID),
		LocationID:         domainUUIDPtr(row.LocationID),
		Type:               domain.UserType(row.Type),
		Status:             domain.UserStatus(row.Status),
		VendorID:           domainUUIDPtr(row.VendorID),
		VendorNameOverride: textPtr(row.VendorNameOverride),
	}
}

// profileRowToUser projects the GET /auth/me read onto the domain account.
// Same role_id gap as loginRowToUser; created_at IS present on this row.
func profileRowToUser(row db.GetUserByIDRow) domain.User {
	return domain.User{
		ID:                 mustDomainUUID(row.ID),
		Name:               row.Name,
		Email:              row.Email,
		Phone:              textValue(row.Phone),
		NIK:                textValue(row.Nik),
		AvatarURL:          textValue(row.AvatarUrl),
		RoleID:             mustDomainUUID(row.RoleID),
		LocationID:         domainUUIDPtr(row.LocationID),
		Type:               domain.UserType(row.Type),
		Status:             domain.UserStatus(row.Status),
		VendorID:           domainUUIDPtr(row.VendorID),
		VendorNameOverride: textPtr(row.VendorNameOverride),
		CreatedAt:          row.CreatedAt,
	}
}

// securityRowToUser projects one branch security account. Same role_id gap.
func securityRowToUser(row db.ListSecurityUsersRow) domain.User {
	return domain.User{
		ID:         mustDomainUUID(row.ID),
		Name:       row.Name,
		Email:      row.Email,
		Phone:      textValue(row.Phone),
		NIK:        textValue(row.Nik),
		AvatarURL:  textValue(row.AvatarUrl),
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

// nikPtr maps the domain NIK the same way: empty means SQL NULL, never an
// empty-string nik row (which chk_users_nik would reject).
func nikPtr(nik string) *string {
	if nik == "" {
		return nil
	}
	return &nik
}

// avatarPtr maps the domain avatar URL the same way as nikPtr: empty means SQL
// NULL, so "no avatar" has one representation.
func avatarPtr(avatarURL string) *string {
	if avatarURL == "" {
		return nil
	}
	return &avatarURL
}

// textValue renders a nullable text column as a plain string, NULL as "".
func textValue(t pgtype.Text) string {
	if !t.Valid {
		return ""
	}
	return t.String
}
