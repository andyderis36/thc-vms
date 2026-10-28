// Package auth implements the email+password authentication usecase for the
// four RBAC roles (super_admin, admin, security, vendor). It depends only on
// domain ports plus two narrow local seams - Issuer and RoleDirectory - so
// the production wiring stays in cmd without the usecase importing
// infrastructure or SQL row types.
package auth

import (
	"context"
	"errors"
	"strings"
	"time"

	"thc-vms/backend/internal/domain"
)

// errUnwired marks a missing collaborator: a wiring bug, never a user error,
// so FromError renders it a generic 500 without leaking internals.
var errUnwired = errors.New("auth: service collaborator not configured")

// Issuer mints the bearer token. It is satisfied structurally by the JWT
// service, keeping this package independent of the infrastructure layer.
type Issuer interface {
	Issue(user domain.User) (string, error)
}

// RoleDirectory resolves a role id to its canonical name for the token-adjacent
// profile projection. Port gap: neither domain.User nor domain.UserRepository
// carries the joined role name the login row already has (the SQL selects
// r.name but the port drops it), and no domain port resolves RoleID to a
// name, so this minimal seam lives here. The repository owner backs it with
// one indexed primary-key lookup; tests use a map.
type RoleDirectory interface {
	LookupRole(ctx context.Context, id domain.UUID) (domain.RoleName, error)
}

// Profile mirrors the openapi User projection: the enriched account view
// returned beside the token and by GET /auth/me. Nullable columns stay
// pointers so location_id renders as JSON null for super_admin and vendor.
// VendorName resolves best-effort through the vendors port (nil when the
// caller wires no catalogue, e.g. hermetic tests).
//
// AvatarURL is the freshly minted presigned URL ("" when the account has no
// photo or storage is unavailable), never the raw bucket address stored in
// the database. EditableFields is the role-derived self-service policy table
// from EditableFields(role), so the client never has to duplicate it.
type Profile struct {
	ID             domain.UUID
	Name           string
	Email          string
	Phone          string
	NIK            string
	Role           domain.RoleName
	LocationID     *domain.UUID
	LocationName   *string
	Status         domain.UserStatus
	Type           domain.UserType
	VendorName     *string
	AvatarURL      string
	EditableFields []string
}

// LoginResult mirrors the openapi LoginResponse data object.
type LoginResult struct {
	Token string
	User  Profile
}

// Deps bundles the service collaborators in one named struct so the
// constructor keeps a single parameter. Every field is required except
// Vendors (nil catalogue means vendor names stay nil), Clock (nil falls back
// to the wall clock) and Audit (nil disables the login trail: hermetic tests
// and unwired callers log in exactly as before).
type Deps struct {
	Users     domain.UserRepository
	Roles     RoleDirectory
	Locations domain.MasterDataRepository
	Vendors   domain.VendorRepository
	Issuer    Issuer
	Clock     domain.Clock
	Audit     domain.AuditRepository
	// Profiles is the self-service write port behind PATCH /auth/me. It is a
	// separate port from Users so the narrow login fakes keep compiling; a nil
	// value only disables UpdateSelf (500), never login/logout/me.
	Profiles domain.ProfileRepository
}

// Service is the authentication usecase.
type Service struct {
	users     domain.UserRepository
	roles     RoleDirectory
	locations domain.MasterDataRepository
	vendors   domain.VendorRepository
	issuer    Issuer
	clock     domain.Clock
	audit     domain.AuditRepository
	profiles  domain.ProfileRepository
	// storage mints the short-lived avatar URL served on reads. It is wired
	// after construction via WithFileLinks so existing NewService callers
	// (tests, workers) keep compiling; a nil store blanks the avatar instead
	// of leaking a raw private-bucket address.
	storage domain.IStorageService
	// presignTTL is the presigned-URL lifetime forwarded to the adapter.
	presignTTL time.Duration
}

// NewService wires the collaborators. A nil Clock defaults to SystemClock;
// the remaining fields must be non-nil or calls fail closed with 500.
func NewService(d Deps) *Service {
	if d.Clock == nil {
		d.Clock = domain.SystemClock{}
	}
	return &Service{
		users:     d.Users,
		roles:     d.Roles,
		locations: d.Locations,
		vendors:   d.Vendors,
		issuer:    d.Issuer,
		clock:     d.Clock,
		audit:     d.Audit,
		profiles:  d.Profiles,
	}
}

// profile builds the enriched projection for one account. A nil LocationID
// yields nil names (JSON null); otherwise the branch name resolves through
// the master-data port, which production scopes per the caller's branch.
func (s *Service) profile(ctx context.Context, user domain.User) (Profile, error) {
	if s.roles == nil || s.locations == nil {
		return Profile{}, domain.FromError(errUnwired)
	}
	role, err := s.roles.LookupRole(ctx, user.RoleID)
	if err != nil {
		return Profile{}, domain.FromError(err)
	}
	out := Profile{
		ID:             user.ID,
		Name:           user.Name,
		Email:          user.Email,
		Phone:          user.Phone,
		NIK:            user.NIK,
		Role:           role,
		Status:         user.Status,
		Type:           user.Type,
		EditableFields: EditableFields(role),
	}
	if user.LocationID != nil {
		out.LocationID = user.LocationID
		loc, err := s.locations.FindLocationByID(ctx, *user.LocationID)
		if err != nil {
			return Profile{}, domain.FromError(err)
		}
		name := loc.Name
		out.LocationName = &name
	}
	// Company display name is best-effort: a vendor-less row, an unwired
	// catalogue (hermetic tests) or a deleted vendor leaves VendorName nil
	// rather than failing the login/profile read. The manually typed company
	// (migration 000005) wins when present — the write paths never store it
	// alongside a vendor_id, so a present override implies no catalogue link —
	// otherwise the catalogue name resolves as before.
	if user.VendorNameOverride != nil && strings.TrimSpace(*user.VendorNameOverride) != "" {
		name := strings.TrimSpace(*user.VendorNameOverride)
		out.VendorName = &name
	} else if user.VendorID != nil && s.vendors != nil {
		if name, err := s.vendors.FindVendorName(ctx, *user.VendorID); err == nil {
			out.VendorName = &name
		}
	}
	out.AvatarURL = s.presignStoredURL(ctx, user.AvatarURL)
	return out, nil
}
