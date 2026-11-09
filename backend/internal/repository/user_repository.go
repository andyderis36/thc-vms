package repository

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
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

// NewUserLocationRepository exposes the same PostgreSQL adapter through the
// branch-coverage port the per-request scope resolution reads. It is a
// separate constructor for the same reason NewManagedUserRepository is.
func NewUserLocationRepository(pool *pgxpool.Pool) domain.UserLocationRepository {
	return &userRepository{pool: pool}
}

// queries returns the pool-scoped generated query set.
func (r *userRepository) queries() *db.Queries {
	return db.New(r.pool)
}

// mapAccountWriteError funnels an account-write store failure: a foreign-key
// violation means a branch the catalogue pre-check just saw vanished
// mid-transaction (TOCTOU), so it is an unknown location (400 via the
// delivery mapping), never a state clash. Every other failure keeps the
// global mapping (duplicate email stays 409).
func mapAccountWriteError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23503" {
		return fmt.Errorf("repository: account references unknown location: %w", domain.ErrValidation)
	}
	return MapError(err)
}

// toDomainUUIDs renders driver ids back onto the domain union.
func toDomainUUIDs(ids []uuid.UUID) []domain.UUID {
	out := make([]domain.UUID, 0, len(ids))
	for _, id := range ids {
		out = append(out, mustDomainUUID(id))
	}
	return out
}

// createUnion derives the coverage union for an account INSERT: the caller
// union when the write carried one, otherwise the primary alone. The handler
// resolves the full accept-either union up front, so this only defends
// unwired callers (register, seeds) that set the primary alone.
func createUnion(user domain.User) []uuid.UUID {
	if len(user.LocationIDs) > 0 {
		out := make([]uuid.UUID, 0, len(user.LocationIDs))
		for _, id := range user.LocationIDs {
			if parsed, err := fromDomainUUID(id); err == nil {
				out = append(out, parsed)
			}
		}
		if len(out) > 0 {
			return out
		}
	}
	if user.LocationID == nil {
		return nil
	}
	if parsed, err := fromDomainUUID(*user.LocationID); err == nil {
		return []uuid.UUID{parsed}
	}
	return nil
}

// updateUnion derives the coverage union for an account UPDATE: the patch
// union when the write carried one, otherwise the RETURNING primary (a keep
// re-inserts the stored branch, a move replaces it). A raced branch delete
// surfaces through mapAccountWriteError at the insert below.
func updateUnion(patch domain.ManagedUserPatch, primary pgtype.UUID) []uuid.UUID {
	if len(patch.LocationIDs) > 0 {
		out := make([]uuid.UUID, 0, len(patch.LocationIDs))
		for _, id := range patch.LocationIDs {
			if parsed, err := fromDomainUUID(id); err == nil {
				out = append(out, parsed)
			}
		}
		if len(out) > 0 {
			return out
		}
	}
	if primary.Valid {
		return []uuid.UUID{uuid.UUID(primary.Bytes)}
	}
	return nil
}

// syncUserLocations maintains the coverage union beside the primary inside
// the caller's transaction: delete-then-insert of the FULL union, so the
// two stores commit atomically and a raced branch delete rolls everything
// back instead of stranding a half-moved account. A coverage FK violation
// (a branch deleted after the catalogue pre-check) is ErrValidation, never
// a 500. Reads never call this: the scope SELECT stays on its own query
// while the listings batch-load coverage beside their current queries.
func syncUserLocations(ctx context.Context, q *db.Queries, userID uuid.UUID, union []uuid.UUID) error {
	if err := q.DeleteUserLocationsByUserID(ctx, db.DeleteUserLocationsByUserIDParams{UserID: userID}); err != nil {
		return MapError(err)
	}
	for _, locationID := range union {
		if err := q.InsertUserLocation(ctx, db.InsertUserLocationParams{
			UserID:     userID,
			LocationID: locationID,
		}); err != nil {
			return mapAccountWriteError(err)
		}
	}
	return nil
}

// batchCoverage loads the branch-coverage union for every listed user in one
// round trip, regrouped by user id. Each group arrives ordered by branch
// (the query sorts by user then branch); the caller forces the primary
// first. A user with no coverage rows is absent from the map, so the caller
// falls back to its primary.
func (r *userRepository) batchCoverage(ctx context.Context, userIDs []uuid.UUID) (map[uuid.UUID][]domain.UUID, error) {
	out := make(map[uuid.UUID][]domain.UUID, len(userIDs))
	if len(userIDs) == 0 {
		return out, nil
	}
	rows, err := r.queries().ListUserLocationsByUserIDs(ctx, db.ListUserLocationsByUserIDsParams{UserIds: userIDs})
	if err != nil {
		return nil, MapError(err)
	}
	for _, row := range rows {
		out[row.UserID] = append(out[row.UserID], mustDomainUUID(row.LocationID))
	}
	return out, nil
}

// unionForRead orders one user's coverage for list/detail output: the
// primary first (matching the create/update echo), the remaining branches
// ascending. Zero coverage rows fall back to the primary alone (legacy
// single-branch rows), or to an empty non-nil slice for a primary-less
// vendor, never nil.
func unionForRead(primary *domain.UUID, coverage []domain.UUID) []domain.UUID {
	out := make([]domain.UUID, 0, len(coverage)+1)
	if primary != nil && *primary != "" {
		out = append(out, *primary)
	}
	for _, id := range coverage {
		if primary != nil && id == *primary {
			continue
		}
		out = append(out, id)
	}
	if len(out) == 0 {
		return []domain.UUID{}
	}
	return out
}

// FindByEmail resolves the login projection by email address. A missing row
// becomes domain.ErrNotFound so the auth caller maps it to 401.
func (r *userRepository) FindByEmail(ctx context.Context, email string) (domain.User, error) {
	row, err := r.queries().GetUserByEmailForLogin(ctx, db.GetUserByEmailForLoginParams{Email: email})
	if err != nil {
		return domain.User{}, MapError(err)
	}
	u := loginRowToUser(row)
	coverage, err := r.ListUserLocationIDs(ctx, u.ID)
	if err != nil {
		return domain.User{}, err
	}
	u.LocationIDs = unionForRead(u.LocationID, coverage)
	return u, nil
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
	u := profileRowToUser(row)
	coverage, err := r.ListUserLocationIDs(ctx, u.ID)
	if err != nil {
		return domain.User{}, err
	}
	u.LocationIDs = unionForRead(u.LocationID, coverage)
	return u, nil
}

// UpdateProfile stores the caller's own resolved profile fields and returns the
// refreshed row. An empty phone or avatar is written as SQL NULL (mirroring
// nikPtr); the generated statement re-reads the same joined projection as
// GetUserByID, so the row maps through profileRowToUser unchanged. A non-empty
// PasswordHash rotates the bcrypt hash in the same transaction (empty keeps
// the stored hash); the plaintext password never reaches this adapter.
func (r *userRepository) UpdateProfile(ctx context.Context, id domain.UUID, update domain.ProfileUpdate) (domain.User, error) {
	parsed, err := fromDomainUUID(id)
	if err != nil {
		return domain.User{}, err
	}
	if update.PasswordHash == "" {
		row, err := r.queries().UpdateUserProfile(ctx, db.UpdateUserProfileParams{
			ID:        parsed,
			Name:      update.Name,
			Phone:     pgText(phonePtr(update.Phone)),
			AvatarUrl: pgText(avatarPtr(update.AvatarURL)),
			Email:     update.Email,
		})
		if err != nil {
			return domain.User{}, MapError(err)
		}
		// UpdateUserProfileRow and GetUserByIDRow are the same projection, so the
		// conversion keeps profileRowToUser the single source of row->domain.
		u := profileRowToUser(db.GetUserByIDRow(row))
		coverage, err := r.ListUserLocationIDs(ctx, u.ID)
		if err != nil {
			return domain.User{}, err
		}
		u.LocationIDs = unionForRead(u.LocationID, coverage)
		return u, nil
	}
	var row db.UpdateUserProfileRow
	err = WithTx(ctx, r.pool, func(tx pgx.Tx) error {
		queries := db.New(tx)
		affected, err := queries.UpdateUserPasswordHash(ctx, db.UpdateUserPasswordHashParams{
			PasswordHash: update.PasswordHash,
			ID:           parsed,
		})
		if err != nil {
			return MapError(err)
		}
		if affected == 0 {
			return domain.ErrNotFound
		}
		row, err = queries.UpdateUserProfile(ctx, db.UpdateUserProfileParams{
			ID:        parsed,
			Name:      update.Name,
			Phone:     pgText(phonePtr(update.Phone)),
			AvatarUrl: pgText(avatarPtr(update.AvatarURL)),
			Email:     update.Email,
		})
		return MapError(err)
	})
	if err != nil {
		return domain.User{}, err
	}
	u := profileRowToUser(db.GetUserByIDRow(row))
	coverage, err := r.ListUserLocationIDs(ctx, u.ID)
	if err != nil {
		return domain.User{}, err
	}
	u.LocationIDs = unionForRead(u.LocationID, coverage)
	return u, nil
}

// Create persists a branch security account. The only generated user INSERT is
// InsertSecurityUser (type 'internal', status 'active'), which is exactly the
// POST /users/security path this port serves in the MVP. The primary INSERT
// and its coverage row commit in one transaction, so a failed coverage write
// rolls the account back instead of stranding it without a branch union.
func (r *userRepository) Create(ctx context.Context, user domain.User) (domain.User, error) {
	roleID, err := fromDomainUUID(user.RoleID)
	if err != nil {
		return domain.User{}, err
	}
	locationID, err := pgNullUUIDPtr(user.LocationID)
	if err != nil {
		return domain.User{}, err
	}
	var row db.InsertSecurityUserRow
	var union []uuid.UUID
	err = WithTx(ctx, r.pool, func(tx pgx.Tx) error {
		queries := db.New(tx)
		row, err = queries.InsertSecurityUser(ctx, db.InsertSecurityUserParams{
			Name:         user.Name,
			Email:        user.Email,
			PasswordHash: user.PasswordHash,
			Phone:        pgText(phonePtr(user.Phone)),
			RoleID:       roleID,
			LocationID:   locationID,
		})
		if err != nil {
			return mapAccountWriteError(err)
		}
		union = createUnion(user)
		return syncUserLocations(ctx, queries, row.ID, union)
	})
	if err != nil {
		return domain.User{}, err
	}
	return domain.User{
		ID:           mustDomainUUID(row.ID),
		Name:         row.Name,
		Email:        row.Email,
		PasswordHash: user.PasswordHash,
		Phone:        textValue(row.Phone),
		RoleID:       mustDomainUUID(row.RoleID),
		LocationID:   domainUUIDPtr(row.LocationID),
		LocationIDs:  toDomainUUIDs(union),
		Type:         domain.UserType(row.Type),
		Status:       domain.UserStatus(row.Status),
		CreatedAt:    row.CreatedAt,
		UpdatedAt:    row.UpdatedAt,
	}, nil
}

// UpdateStatus flips an account between active, pending and inactive. The
// database CHECK additionally refuses values outside the account vocabulary.
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

// ListSecurity returns the gate staff of the given branch union, or of every
// branch when isGlobal is true (super_admin only). The branch predicate lives
// in the generated query as a bound parameter, never in Go string code. The
// hidden dev-superadmin account never surfaces here: rows matching
// domain.IsHiddenDevAccount are dropped after the read (the role has no
// branch scope, so no SQL branch predicate could express the exclusion
// without a second join).
func (r *userRepository) ListSecurity(ctx context.Context, locationIDs []domain.UUID, isGlobal bool) ([]domain.User, error) {
	union := make([]uuid.UUID, 0, len(locationIDs))
	for _, id := range locationIDs {
		parsed, err := fromDomainUUID(id)
		if err != nil {
			return nil, err
		}
		union = append(union, parsed)
	}
	rows, err := r.queries().ListSecurityUsers(ctx, db.ListSecurityUsersParams{IsGlobal: isGlobal, LocationIds: union})
	if err != nil {
		return nil, MapError(err)
	}
	ids := make([]uuid.UUID, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	unions, err := r.batchCoverage(ctx, ids)
	if err != nil {
		return nil, err
	}
	out := make([]domain.User, 0, len(rows))
	for _, row := range rows {
		// Role name is the primary signal; the email fallback covers
		// pre-000016/data-drift rows whose role no longer reads
		// dev-superadmin but still hold the seeded operator account.
		if domain.IsHiddenDevAccount(domain.RoleName(row.Role), row.Email) {
			continue
		}
		u := securityRowToUser(row)
		u.LocationIDs = unionForRead(u.LocationID, unions[row.ID])
		out = append(out, u)
	}
	return out, nil
}

// ListUserLocationIDs returns the branch-coverage union of one user from
// user_locations, ordered for determinism. The generated query emits an empty
// (non-nil) slice when the user holds no coverage, so callers can tell "no
// branches" apart from a lookup failure without a nil check.
func (r *userRepository) ListUserLocationIDs(ctx context.Context, userID domain.UUID) ([]domain.UUID, error) {
	parsed, err := fromDomainUUID(userID)
	if err != nil {
		return nil, err
	}
	rows, err := r.queries().ListUserLocationIDs(ctx, db.ListUserLocationIDsParams{UserID: parsed})
	if err != nil {
		return nil, MapError(err)
	}
	out := make([]domain.UUID, 0, len(rows))
	for _, row := range rows {
		out = append(out, toDomainUUID(row))
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
	var scope []uuid.UUID
	isGlobal := false
	if filter.LocationID == nil {
		scope = []uuid.UUID{}
		isGlobal = true
	} else {
		parsed, err := fromDomainUUID(*filter.LocationID)
		if err != nil {
			return nil, err
		}
		scope = []uuid.UUID{parsed}
	}
	rows, err := r.queries().ListManagedUsers(ctx, db.ListManagedUsersParams{
		Role:        role,
		Search:      search,
		IsGlobal:    isGlobal,
		LocationIds: scope,
	})
	if err != nil {
		return nil, MapError(err)
	}
	ids := make([]uuid.UUID, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	unions, err := r.batchCoverage(ctx, ids)
	if err != nil {
		return nil, err
	}
	out := make([]domain.ManagedUser, 0, len(rows))
	for _, row := range rows {
		// Role name is the primary signal; the email fallback covers
		// pre-000016/data-drift rows whose role no longer reads
		// dev-superadmin but still hold the seeded operator account.
		if domain.IsHiddenDevAccount(domain.RoleName(row.Role), row.Email) {
			continue
		}
		m := managedListRowToUser(row)
		m.User.LocationIDs = unionForRead(m.User.LocationID, unions[row.ID])
		out = append(out, m)
	}
	return out, nil
}

// CreateManagedUser persists one admin or vendor account for POST /users. The
// caller sets RoleID, Type, Status, LocationID and VendorID after the
// usecase validation; the enforce_user_location_invariant trigger rejects
// any pairing the validation missed (check_violation -> ErrValidation via
// MapError) and users_email_key rejects a duplicate email (23505 ->
// ErrConflict via MapError, the same mapping POST /users/security relies
// on, rendered as 409 by the handler). The primary INSERT and its coverage
// row commit in one transaction, like Create.
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
	var row db.InsertManagedUserRow
	var union []uuid.UUID
	err = WithTx(ctx, r.pool, func(tx pgx.Tx) error {
		queries := db.New(tx)
		row, err = queries.InsertManagedUser(ctx, db.InsertManagedUserParams{
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
			return mapAccountWriteError(err)
		}
		union = createUnion(user)
		return syncUserLocations(ctx, queries, row.ID, union)
	})
	if err != nil {
		return domain.User{}, err
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
		LocationIDs:        toDomainUUIDs(union),
		Type:               domain.UserType(row.Type),
		Status:             domain.UserStatus(row.Status),
		VendorID:           domainUUIDPtr(row.VendorID),
		VendorNameOverride: textPtr(row.VendorNameOverride),
		CreatedAt:          row.CreatedAt,
		UpdatedAt:          row.UpdatedAt,
	}, nil
}

// UpdateManagedUser applies a partial super_admin edit for PATCH /users/:id
// (and, through the same port, the PATCH /users/security/:id branch move).
// Nil patch members keep the stored columns via COALESCE (patchMemberText /
// pgNullUUIDPtr render nil as SQL NULL); a duplicate email surfaces
// ErrConflict and a missing id ErrNotFound through MapError, the same
// mappings POST /users relies on. The primary UPDATE and the coverage
// delete-then-insert commit in one transaction against the RETURNING row's
// effective primary, so a keep re-inserts the stored branch while a move
// replaces it, and a rejected move rolls both stores back untouched.
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
	var row db.UpdateManagedUserRow
	var union []uuid.UUID
	err = WithTx(ctx, r.pool, func(tx pgx.Tx) error {
		queries := db.New(tx)
		row, err = queries.UpdateManagedUser(ctx, db.UpdateManagedUserParams{
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
			return mapAccountWriteError(err)
		}
		union = updateUnion(patch, row.LocationID)
		if err := syncUserLocations(ctx, queries, row.ID, union); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return domain.User{}, err
	}
	return domain.User{
		ID:                 mustDomainUUID(row.ID),
		Name:               row.Name,
		Email:              row.Email,
		Phone:              textValue(row.Phone),
		NIK:                textValue(row.Nik),
		RoleID:             mustDomainUUID(row.RoleID),
		LocationID:         domainUUIDPtr(row.LocationID),
		LocationIDs:        toDomainUUIDs(union),
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
	m := domain.ManagedUser{
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
	}
	unions, err := r.batchCoverage(ctx, []uuid.UUID{row.ID})
	if err != nil {
		return domain.ManagedUser{}, err
	}
	m.User.LocationIDs = unionForRead(m.User.LocationID, unions[row.ID])
	return m, nil
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
