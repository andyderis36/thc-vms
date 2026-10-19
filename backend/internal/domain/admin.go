package domain

import "context"

// This file owns the super_admin back-office ports (PRD §4: kelola lokasi +
// kelola admin/vendor). The interfaces here are NEW and separate from
// UserRepository and MasterDataRepository on purpose: the old handler fakes
// implement only the old ports, so widening those interfaces would break
// their compilation. The PostgreSQL adapters satisfy both the old and the
// new ports with the same structs; no behaviour of the old endpoints changes.

// UserFilter scopes GET /users. Every member is optional: a nil Role means
// every role, an empty Search means no text match, a nil LocationID means
// every branch. There is deliberately no pagination, mirroring ListSecurity.
type UserFilter struct {
	Role       *RoleName
	Search     string
	LocationID *UUID
}

// ManagedUser is one account row projected for the super_admin console: the
// stored User plus the joined names the openapi User schema needs (role,
// location_name, vendor_name). LocationName and VendorName stay nil so they
// render as JSON null for super_admin and vendor rows.
type ManagedUser struct {
	User         User
	Role         RoleName
	LocationName *string
	VendorName   *string
}

// LocationPatch is the partial body of PATCH /locations/:id. A nil member
// means "leave the column unchanged"; the adapter renders nil as SQL NULL so
// COALESCE keeps the stored value.
type LocationPatch struct {
	Name     *string
	Type     *LocationType
	Address  *string
	City     *string
	Timezone *Timezone
	IsActive *bool
}

// ManagedUserPatch is the partial body of PATCH /users/:id. A nil member
// means "leave the column unchanged"; the adapter renders nil as SQL NULL so
// COALESCE keeps the stored value. Role, type, status and password_hash are
// intentionally absent: they change through dedicated flows, never here. NIK
// follows the same per-role rule as create (admin/vendor only) when provided;
// the security-account path never carries it (its handler rejects the key).
type ManagedUserPatch struct {
	Name       *string
	Email      *string
	Phone      *string
	NIK        *string
	LocationID *UUID
	VendorID   *UUID
	// VendorName carries the manual vendor company tri-state (migration 000005),
	// mirroring the phone empty-means-null openapi rule: nil keeps the stored
	// override, a blank value clears it to SQL NULL, a filled value sets it.
	// A simultaneously set VendorID wins and the adapter clears the override.
	VendorName   *string
	PasswordHash *string
}

// ManagedUserRepository is the super_admin account port: full listing with
// filters, creation of admin/vendor accounts, detail read with the resolved
// role name (needed to refuse touches on other super_admins), the status
// flip shared with the security-account path, the partial edit (PATCH
// /users/:id, super_admin only) and the hard delete with its
// reference pre-checks (DELETE /users/:id, super_admin only).
type ManagedUserRepository interface {
	ListManagedUsers(ctx context.Context, filter UserFilter) ([]ManagedUser, error)
	CreateManagedUser(ctx context.Context, user User) (User, error)
	FindManagedByID(ctx context.Context, id UUID) (ManagedUser, error)
	UpdateStatus(ctx context.Context, id UUID, status UserStatus) error
	// UpdateManagedUser applies a partial edit (nil patch members keep the
	// stored columns). A missing id is ErrNotFound; a duplicate email is
	// ErrConflict via MapError's 23505 mapping.
	UpdateManagedUser(ctx context.Context, id UUID, patch ManagedUserPatch) (User, error)
	// CountVisitsByVendorUser reports how many visits the account still owns as vendor
	// (visit_request.vendor_user_id, no cascade): a non-zero count blocks the
	// delete with 409.
	CountVisitsByVendorUser(ctx context.Context, userID UUID) (int64, error)
	// CountStaffReferences reports how many gate/audit rows the account
	// wrote as staff (check_in.checked_in_by + check_out.checked_out_by +
	// status_history.changed_by, all without cascade): non-zero blocks it.
	CountStaffReferences(ctx context.Context, userID UUID) (int64, error)
	// DeleteUser removes the account row. A missing id is ErrNotFound; a
	// raced reference is ErrConflict via MapError's 23503 mapping.
	DeleteUser(ctx context.Context, id UUID) error
}

// LocationAdminRepository is the super_admin facility port: it embeds the
// read-only MasterDataRepository catalogue and adds the location writes plus
// the hard delete with its reference pre-checks (DELETE /locations/:id,
// super_admin only). The soft removal stays deactivation via is_active; the
// hard delete is refused with 409 while users or visits still reference the
// row, so operational history is never orphaned by accident.
type LocationAdminRepository interface {
	MasterDataRepository
	CreateLocation(ctx context.Context, loc Location) (Location, error)
	UpdateLocation(ctx context.Context, id UUID, patch LocationPatch) (Location, error)
	// CountUsersByLocation reports accounts stationed at the facility
	// (users.location_id, no cascade): non-zero blocks the delete with 409.
	CountUsersByLocation(ctx context.Context, locationID UUID) (int64, error)
	// CountVisitsByLocation reports visits hosted at the facility
	// (visit_request.location_id, no cascade): non-zero blocks it with 409.
	CountVisitsByLocation(ctx context.Context, locationID UUID) (int64, error)
	// DeleteLocation removes the facility row. Missing is ErrNotFound;
	// a raced reference is ErrConflict via MapError's 23503 mapping.
	DeleteLocation(ctx context.Context, id UUID) error
}
