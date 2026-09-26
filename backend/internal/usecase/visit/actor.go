// Package visit implements the visit lifecycle usecase: the business rules for
// creating a visit request and moving it through its lifecycle, as pure logic
// on the domain ports. It performs no SQL, holds no transactions and serves no
// HTTP; the repository owns the atomic status+history write and the row lock.
package visit

import (
	"thc-vms/backend/internal/domain"
)

// Actor is the authenticated caller behind a usecase invocation: its user id,
// its RBAC role and, for branch-bound roles, its location. No sibling usecase
// package publishes a compatible type, so it lives here.
type Actor struct {
	ID         domain.UUID
	Role       domain.RoleName
	LocationID *domain.UUID
}

// IsSecurity reports whether the actor is gate staff.
func (a Actor) IsSecurity() bool {
	return a.Role == domain.RoleSecurity
}

// requireRole refuses the actor unless it carries one of the allowed roles.
// The refusal reuses domain.ForbiddenBranch so role violations surface as 403.
func (a Actor) requireRole(allowed ...domain.RoleName) error {
	for _, role := range allowed {
		if a.Role == role {
			return nil
		}
	}
	return domain.ForbiddenBranch()
}

// requireBranch enforces multi-branch isolation: super_admin passes everywhere,
// while every other role must carry the branch of the visit it touches. The
// message comes from the sentinel and is never retyped.
func (a Actor) requireBranch(locationID domain.UUID) error {
	if a.Role == domain.RoleSuperAdmin {
		return nil
	}
	if a.LocationID == nil || *a.LocationID != locationID {
		return domain.ForbiddenBranch()
	}
	return nil
}

// Service is the visit lifecycle usecase. Every port arrives via constructor
// injection; there are no globals and no singletons.
type Service struct {
	visits domain.VisitRepository
	master domain.MasterDataRepository
	clock  domain.Clock
}

// NewService wires the visit usecase to its domain ports.
func NewService(visits domain.VisitRepository, master domain.MasterDataRepository, clock domain.Clock) *Service {
	return &Service{visits: visits, master: master, clock: clock}
}
