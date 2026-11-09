// Package gate owns the security-gate usecase: check-in and check-out at the
// facility gate (SCR-05). It is pure business logic over the domain ports —
// no database, no HTTP — so every guard stays unit-testable with an injected
// clock and hand-written fakes.
package gate

import (
	"context"
	"log/slog"

	"thc-vms/backend/internal/domain"
	visituc "thc-vms/backend/internal/usecase/visit"
)

// Actor is the authenticated caller of a gate operation: the staff id, the
// RBAC role and, for branch-locked roles, the caller's own location.
// Branches and IsGlobal carry the stashed thc.scope union; an empty union
// with IsGlobal false falls back to the scalar LocationID rule.
type Actor struct {
	ID         domain.UUID
	Role       domain.RoleName
	LocationID *domain.UUID
	Branches   []domain.UUID
	IsGlobal   bool
}

// Dependencies wires the gate service to its ports. Clock is mandatory in
// production (domain.SystemClock) and frozen in tests; Logger defaults to
// slog.Default when nil.
type Dependencies struct {
	Visits   domain.VisitRepository
	CheckIns domain.CheckInOutRepository
	Clock    domain.Clock
	Logger   *slog.Logger
	// Mailer is the outbound email port. It is OPTIONAL: nil only disables
	// email fan-out, it never fails a gate operation.
	Mailer domain.Mailer
	// TrustedFileOrigins lists the deployment's own object-storage hosts so the
	// check-in photo allowlist accepts the plain-HTTP URLs the storage adapter
	// hands out on a LAN deployment without TLS.
	TrustedFileOrigins visituc.FileOriginAllowlist
}

// Service executes gate operations against the injected ports.
type Service struct {
	visits   domain.VisitRepository
	checkIns domain.CheckInOutRepository
	clock    domain.Clock
	logger   *slog.Logger
	// mailer is the outbound email port (OPTIONAL: nil only disables email
	// fan-out). The service holds only this domain port; the SMTP transport
	// stays in infrastructure.
	mailer domain.Mailer
	// trustedFileOrigins is the deployment's own object-storage hosts, used by
	// the shared uploaded-file URL allowlist.
	trustedFileOrigins visituc.FileOriginAllowlist
}

// NewService builds a gate service, defaulting a nil clock to the wall clock
// and a nil logger to slog.Default so the service never holds a nil.
func NewService(deps Dependencies) *Service {
	clock := deps.Clock
	if clock == nil {
		clock = domain.SystemClock{}
	}
	logger := deps.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &Service{
		visits:             deps.Visits,
		checkIns:           deps.CheckIns,
		clock:              clock,
		logger:             logger,
		mailer:             deps.Mailer,
		trustedFileOrigins: deps.TrustedFileOrigins,
	}
}

// authorizeGateRole admits the two gate roles plus the bypass role. Vendor is an
// external account that must never execute a gate operation.
func authorizeGateRole(role domain.RoleName) error {
	switch role {
	case domain.RoleSecurity, domain.RoleAdmin, domain.RoleSuperAdmin, domain.RoleDevSuperAdmin:
		return nil
	default:
		return domain.ForbiddenBranch()
	}
}

// authorizeBranch locks admin and security to their own location. super_admin
// bypasses the filter (approval matrix "Ya (Bypass)"); a stashed global
// passes; a union member passes even when the target differs from the scalar
// primary; anything else falls back to the scalar rule, so callers without a
// stash decide exactly as before. A branch-locked actor without a location
// is refused rather than treated as global.
func authorizeBranch(actor Actor, visit domain.VisitRequest) error {
	if domain.IsSuperAdminRole(actor.Role) {
		return nil
	}
	if actor.IsGlobal {
		return nil
	}
	for _, id := range actor.Branches {
		if id == visit.LocationID {
			return nil
		}
	}
	if actor.LocationID == nil || *actor.LocationID != visit.LocationID {
		return domain.ForbiddenBranch()
	}
	return nil
}

// resolveVisit accepts either the UUID or the VST- business code printed on
// the QR pass, reporting a missing visit as NotFoundEntity("Kunjungan").
func (s *Service) resolveVisit(ctx context.Context, visitIDOrCode string) (domain.VisitRequest, error) {
	if isVisitCode(visitIDOrCode) {
		visit, err := s.visits.FindByVisitCode(ctx, visitIDOrCode)
		if err != nil {
			return domain.VisitRequest{}, domain.NotFoundEntity("Kunjungan")
		}
		return visit, nil
	}
	visit, err := s.visits.FindByID(ctx, domain.UUID(visitIDOrCode))
	if err != nil {
		return domain.VisitRequest{}, domain.NotFoundEntity("Kunjungan")
	}
	return visit, nil
}

// isVisitCode distinguishes the VST- business code from a UUID.
func isVisitCode(idOrCode string) bool {
	const prefix = "VST-"
	if len(idOrCode) < len(prefix) {
		return false
	}
	return idOrCode[:len(prefix)] == prefix
}
