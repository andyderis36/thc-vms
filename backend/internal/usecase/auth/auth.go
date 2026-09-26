// Package auth implements the email+password authentication usecase for the
// four RBAC roles (super_admin, admin, security, pic). It depends only on
// domain ports plus two narrow local seams - Issuer and RoleDirectory - so
// the production wiring stays in cmd without the usecase importing
// infrastructure or SQL row types.
package auth

import (
	"context"
	"errors"

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
// pointers so location_id renders as JSON null for super_admin and pic.
// VendorName stays nil: no domain port resolves the vendor name, which is a
// display-only gap the delivery layer tolerates.
type Profile struct {
	ID           domain.UUID
	Name         string
	Email        string
	Phone        string
	Role         domain.RoleName
	LocationID   *domain.UUID
	LocationName *string
	Status       domain.UserStatus
	Type         domain.UserType
	VendorName   *string
}

// LoginResult mirrors the openapi LoginResponse data object.
type LoginResult struct {
	Token string
	User  Profile
}

// Deps bundles the service collaborators in one named struct so the
// constructor keeps a single parameter. Every field is required; a nil Clock
// falls back to the wall clock.
type Deps struct {
	Users     domain.UserRepository
	Roles     RoleDirectory
	Locations domain.MasterDataRepository
	Issuer    Issuer
	Clock     domain.Clock
}

// Service is the authentication usecase.
type Service struct {
	users     domain.UserRepository
	roles     RoleDirectory
	locations domain.MasterDataRepository
	issuer    Issuer
	clock     domain.Clock
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
		issuer:    d.Issuer,
		clock:     d.Clock,
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
		ID:     user.ID,
		Name:   user.Name,
		Email:  user.Email,
		Phone:  user.Phone,
		Role:   role,
		Status: user.Status,
		Type:   user.Type,
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
	return out, nil
}
