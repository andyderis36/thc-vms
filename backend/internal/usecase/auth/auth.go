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

	"thc-vms/backend/internal/avatarpath"
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
// AvatarURL is the host-agnostic API path (/api/v1/avatars/{id}?v=...) whose
// bytes GET /avatars/{id} streams ("" when the account has no photo), never
// the raw bucket address stored in the database. EditableFields is the
// role-derived self-service policy table from EditableFields(role), so the
// client never has to duplicate it.
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
// to the wall clock), Audit (nil disables the login trail: hermetic tests
// and unwired callers log in exactly as before), Storage (nil only
// disables the avatar ownership proof on PATCH /auth/me), Managed and
// VendorRoleID (nil/empty only disables POST /auth/register).
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
	// Managed is the managed-account write port behind POST /auth/register.
	// A nil value disables self-registration (500), never login/logout/me.
	Managed domain.ManagedUserRepository
	// VendorRoleID is the role row id stamped onto self-registered accounts.
	// Empty disables POST /auth/register (500 wiring bug, never a user error).
	VendorRoleID domain.UUID
	// Storage reverses a submitted avatar URL to its object key so the
	// self-service write can prove the photo belongs to the caller's own
	// upload namespace. It never mints read URLs: avatar reads stream through
	// GET /avatars/{id}.
	Storage domain.IStorageService
	// Mailer delivers the email-change notices (the verification link to the
	// new inbox, the security copy to the old address and the success copy to
	// the new one). Every send is best-effort: a failure is logged and the
	// request still succeeds. A nil value disables the notices (hermetic
	// tests), never the token mint or the flip itself.
	Mailer domain.Mailer
	// EmailTokens mints and verifies the stateless tokens confirming an
	// email-address change. A nil value disables Request/Confirm (500), never
	// login/logout/me.
	EmailTokens EmailChangeTokens
	// FrontendBaseURL is the public web origin the verification mail links
	// back to (for example http://localhost:3210 in local dev). The confirm
	// link is FrontendBaseURL + "/verify-email?token=" + token, matching the
	// frontend /verify-email route. Empty keeps the relative "/verify-email"
	// fallback so hermetic tests stay link-free.
	FrontendBaseURL string
	// Notices is the vendor-registration queue port behind POST
	// /auth/register. A nil value disables only the fan-out (no queue row,
	// no superadmin email), never the registration itself.
	Notices domain.VendorRegistrationNoticeRepository
	// SuperAdmins resolves the active superadmin email set for the
	// registration fan-out. A nil value disables only the email leg.
	SuperAdmins SuperAdminDirectory
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
	// storage backs the avatar ownership proof on the self-service write path.
	storage domain.IStorageService
	managed domain.ManagedUserRepository
	// vendorRoleID is stamped onto self-registered accounts (POST /auth/register).
	vendorRoleID    domain.UUID
	mailer          domain.Mailer
	emailTokens     EmailChangeTokens
	frontendBaseURL string
	notices         domain.VendorRegistrationNoticeRepository
	superAdmins     SuperAdminDirectory
}

// NewService wires the collaborators. A nil Clock defaults to SystemClock;
// the remaining fields must be non-nil or calls fail closed with 500.
func NewService(d Deps) *Service {
	if d.Clock == nil {
		d.Clock = domain.SystemClock{}
	}
	return &Service{
		users:           d.Users,
		roles:           d.Roles,
		locations:       d.Locations,
		vendors:         d.Vendors,
		issuer:          d.Issuer,
		clock:           d.Clock,
		audit:           d.Audit,
		profiles:        d.Profiles,
		storage:         d.Storage,
		managed:         d.Managed,
		vendorRoleID:    d.VendorRoleID,
		mailer:          d.Mailer,
		emailTokens:     d.EmailTokens,
		frontendBaseURL: strings.TrimRight(strings.TrimSpace(d.FrontendBaseURL), "/"),
		notices:         d.Notices,
		superAdmins:     d.SuperAdmins,
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
	// The avatar read path is host-agnostic: the stored bucket URL projects
	// onto the authenticated GET /avatars/{id} stream, so no presigned link
	// and no raw private-bucket address can ever reach the client.
	if path := avatarpath.URL(user.ID, user.AvatarURL); path != nil {
		out.AvatarURL = *path
	}
	return out, nil
}
