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
//
// Branches and IsGlobal carry the stashed thc.scope union resolved once per
// request from user_locations (migration 000023). They widen the branch
// guard, never the listing queries: an empty union with IsGlobal false falls
// back to the scalar LocationID rule exactly as before.
type Actor struct {
	ID         domain.UUID
	Role       domain.RoleName
	LocationID *domain.UUID
	Branches   []domain.UUID
	IsGlobal   bool
}

// IsSecurity reports whether the actor is gate staff.
func (a Actor) IsSecurity() bool {
	return a.Role == domain.RoleSecurity
}

// requireRole refuses the actor unless it carries one of the allowed roles.
// The refusal reuses domain.ForbiddenBranch so role violations surface as 403.
// The hidden dev-superadmin passes wherever super_admin is allowed, without
// being named at any call site.
func (a Actor) requireRole(allowed ...domain.RoleName) error {
	allowsSuperAdmin := false
	for _, role := range allowed {
		if domain.IsSuperAdminRole(role) {
			allowsSuperAdmin = true
			break
		}
	}
	for _, role := range allowed {
		if a.Role == role {
			return nil
		}
	}
	if allowsSuperAdmin && a.Role == domain.RoleDevSuperAdmin {
		return nil
	}
	return domain.ForbiddenBranch()
}

// requireBranchAccess enforces multi-branch isolation: super_admin passes
// everywhere, a stashed global passes, and a union member passes even when
// the target differs from the scalar primary. Anything else falls back to
// the scalar LocationID rule, so callers without a stash (and accounts whose
// coverage rows are not yet written) decide exactly as before. The message
// comes from the sentinel and is never retyped.
func (a Actor) requireBranchAccess(locationID domain.UUID) error {
	if domain.IsSuperAdminRole(a.Role) {
		return nil
	}
	if a.IsGlobal {
		return nil
	}
	for _, id := range a.Branches {
		if id == locationID {
			return nil
		}
	}
	if a.LocationID == nil || *a.LocationID != locationID {
		return domain.ForbiddenBranch()
	}
	return nil
}

// branchUnion resolves the listing scope of a branch-locked actor: the stashed
// user_locations union when present, else the scalar primary alone, else empty
// (fail-closed: the query matches no branch, never all of them). The result is
// a copy so callers cannot mutate the actor's stash through the filter.
func branchUnion(a Actor) []domain.UUID {
	if len(a.Branches) > 0 {
		out := make([]domain.UUID, len(a.Branches))
		copy(out, a.Branches)
		return out
	}
	if a.LocationID != nil {
		return []domain.UUID{*a.LocationID}
	}
	return nil
}

// narrowByRequestedBranch applies the caller-supplied ?location_id= narrowing
// to a scoped actor's union: nil keeps the whole union, a member id narrows the
// filter to exactly that one id, and a foreign id reports false so the caller
// refuses with 403 FORBIDDEN_BRANCH instead of silently ignoring the parameter.
// Admin and security share this rule; the union stays the ceiling either way.
func narrowByRequestedBranch(union []domain.UUID, requested *domain.UUID) ([]domain.UUID, bool) {
	if requested == nil {
		return union, true
	}
	for _, id := range union {
		if id == *requested {
			return []domain.UUID{*requested}, true
		}
	}
	return nil, false
}

// Service is the visit lifecycle usecase. Every port arrives via constructor
// injection; there are no globals and no singletons.
type Service struct {
	visits   domain.VisitRepository
	master   domain.MasterDataRepository
	vendors  domain.VendorRepository
	clock    domain.Clock
	checkIns domain.CheckInOutRepository
	// accounts resolves the ROLE and status of a chosen vendor account on the
	// create path. It is wired after construction via WithAccountLookup so
	// existing NewService callers keep compiling; a nil lookup fails an
	// EXPLICIT vendor_user_id closed, while an absent id (the historical
	// actor-owns-it rule) keeps working without any lookup at all.
	accounts domain.UserAccountLookup
	// storage mints the short-lived file URLs served on reads. It is wired
	// after construction via WithFileLinks so existing NewService callers
	// (tests, workers) keep compiling; a nil storage fails reads closed
	// (blank URLs) rather than leaking raw private-bucket addresses.
	storage domain.IStorageService
	// presignTTL is the presigned-URL lifetime forwarded to the adapter.
	// Always positive: WithFileLinks clamps, effectivePresignTTL repeats
	// the guard for Services built without the setter.
	presignTTL time.Duration
	// objectReader streams stored objects for the scoped GET /visits/:id/file
	// endpoint. It is wired after construction via WithObjectReader so
	// existing NewService callers keep compiling; a nil reader fails reads
	// closed (404) rather than leaking raw private-bucket addresses.
	objectReader domain.ObjectReader
	// trustedFileOrigins lists the hosts whose plain-HTTP file URLs the
	// payload allowlist accepts. It is wired after construction via
	// WithTrustedFileOrigins so existing NewService callers keep compiling;
	// an empty list keeps the strict rule (https only, plus the dev hosts).
	trustedFileOrigins FileOriginAllowlist
	// mailer is the outbound email port, wired after construction via
	// WithMailer so existing NewService callers keep compiling. It is
	// OPTIONAL: nil only disables email fan-out, it never fails a write.
	// The service holds only this domain port; the SMTP transport stays in
	// infrastructure.
	mailer domain.Mailer
	// suggestions is the read-only vendor/member suggestion port, wired after
	// construction via WithSuggestions so existing NewService callers keep
	// compiling. It is OPTIONAL: a nil port fails the suggestion endpoints
	// closed with a storage error instead of inventing an empty dataset.
	suggestions domain.SuggestionRepository
}

// WithAccountLookup wires the account directory used to validate an explicitly
// chosen vendor_user_id and returns the service for chaining at the
// composition root, mirroring WithMailer.
func (s *Service) WithAccountLookup(lookup domain.UserAccountLookup) *Service {
	s.accounts = lookup
	return s
}

// WithTrustedFileOrigins records the deployment's own object-storage hosts so
// the file-URL allowlist accepts the plain-HTTP URLs the storage adapter
// hands out on a LAN deployment without TLS.
func (s *Service) WithTrustedFileOrigins(allow FileOriginAllowlist) *Service {
	s.trustedFileOrigins = allow
	return s
}

// WithMailer wires the outbound email port and returns the service for
// chaining at the composition root, mirroring WithFileLinks. A nil mailer
// only disables email fan-out, it never fails a write.
func (s *Service) WithMailer(mailer domain.Mailer) *Service {
	s.mailer = mailer
	return s
}

// validatePhotoURL applies the shared uploaded-file URL allowlist with this
// service's trusted origins.
func (s *Service) validatePhotoURL(raw string) error {
	return validatePhotoURL(raw, s.trustedFileOrigins)
}

// NewService wires the visit usecase to its domain ports. checkIns may be nil
// (tests, workers): a nil port only disables gate-time enrichment on GetVisit,
// it never fails the read. vendors may be nil in hermetic tests: a nil
// catalogue skips vendor existence validation on CreateVisit, it never fails
// the write; production always wires the real catalogue.
func NewService(visits domain.VisitRepository, master domain.MasterDataRepository, clock domain.Clock, checkIns domain.CheckInOutRepository, vendors domain.VendorRepository) *Service {
	return &Service{visits: visits, master: master, clock: clock, checkIns: checkIns, vendors: vendors}
}
