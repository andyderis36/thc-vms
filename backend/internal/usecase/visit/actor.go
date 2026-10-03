// Package visit implements the visit lifecycle usecase: the business rules for
// creating a visit request and moving it through its lifecycle, as pure logic
// on the domain ports. It performs no SQL, holds no transactions and serves no
// HTTP; the repository owns the atomic status+history write and the row lock.
package visit

import (
	"time"

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
	visits   domain.VisitRepository
	master   domain.MasterDataRepository
	vendors  domain.VendorRepository
	clock    domain.Clock
	checkIns domain.CheckInOutRepository
	// storage mints the short-lived file URLs served on reads. It is wired
	// after construction via WithFileLinks so existing NewService callers
	// (tests, workers) keep compiling; a nil storage fails reads closed
	// (blank URLs) rather than leaking raw private-bucket addresses.
	storage domain.IStorageService
	// presignTTL is the presigned-URL lifetime forwarded to the adapter.
	// Always positive: WithFileLinks clamps, effectivePresignTTL repeats
	// the guard for Services built without the setter.
	presignTTL time.Duration
}

// NewService wires the visit usecase to its domain ports. checkIns may be nil
// (tests, workers): a nil port only disables gate-time enrichment on GetVisit,
// it never fails the read. vendors may be nil in hermetic tests: a nil
// catalogue skips vendor existence validation on CreateVisit, it never fails
// the write; production always wires the real catalogue.
func NewService(visits domain.VisitRepository, master domain.MasterDataRepository, clock domain.Clock, checkIns domain.CheckInOutRepository, vendors domain.VendorRepository) *Service {
	return &Service{visits: visits, master: master, clock: clock, checkIns: checkIns, vendors: vendors}
}
