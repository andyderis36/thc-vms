package visit

import (
	"context"
	"time"

	"thc-vms/backend/internal/domain"
)

// List limits: the default page size and the hard cap callers may request.
const (
	defaultListLimit = 10
	maxListLimit     = 100
)

// ListVisitsInput carries the caller-supplied listing knobs.
//
// LocationID is NOT a scope override: it is the optional NARROWING filter.
// super_admin may narrow to any branch (openapi documents `?location_id=` for
// the central-office view and PRD L109 grants superadmin the ability to filter
// by branch); admin and security may narrow only to a branch inside their own
// coverage union, and a foreign id is refused with 403 FORBIDDEN_BRANCH. A
// caller can therefore never widen their visibility, and no out-of-scope
// filter passes silently.
type ListVisitsInput struct {
	Status *domain.VisitStatus
	// Search is the optional free-text filter (?q=); empty means unfiltered.
	Search string
	From   *time.Time
	To     *time.Time
	Page   int
	Limit  int
	// LocationID narrows the result to one branch. Honoured for super_admin
	// (any branch) and for admin/security (only inside their union, else 403);
	// ignored for vendor, whose owner scope is authoritative.
	LocationID *domain.UUID
	// SortBy/Order select the ORDER BY column and direction (?sort_by=,
	// ?order=). Empty means the legacy default (created_at desc); unknown
	// values are normalised to that default so they can never reach SQL.
	SortBy domain.VisitSortBy
	Order  domain.VisitSortOrder
}

// ListVisits builds the domain.VisitFilter from the actor. This mapping IS the
// multi-branch isolation core and it is total: admin and security see exactly
// their stashed user_locations union (scalar primary only as the fallback when
// no stash was resolved, empty union when neither exists so the listing fails
// closed) and may narrow it to one union member via ?location_id=, a foreign
// id being a 403; vendor sees only its own visits, super_admin sees everything
// unless it narrows by branch, and any unknown role is refused.
func (s *Service) ListVisits(ctx context.Context, actor Actor, in ListVisitsInput) ([]domain.VisitRequest, int64, error) {
	filter := domain.VisitFilter{
		Status: in.Status,
		Search: in.Search,
		From:   in.From,
		To:     in.To,
		Page:   in.Page,
		Limit:  in.Limit,
		SortBy: in.SortBy.Normalized(),
		Order:  in.Order.Normalized(),
	}
	switch actor.Role {
	case domain.RoleAdmin, domain.RoleSecurity:
		// The actor's union is the ceiling: a caller-supplied branch inside it
		// narrows the filter to exactly that id, a foreign id is refused with
		// 403 before any query, and no parameter can widen the union.
		narrowed, inScope := narrowByRequestedBranch(branchUnion(actor), in.LocationID)
		if !inScope {
			if actor.IsGlobal && in.LocationID != nil {
				// A stashed-global branch actor may narrow to any branch,
				// mirroring the super_admin rule.
				narrowed = []domain.UUID{*in.LocationID}
			} else {
				return nil, 0, domain.ForbiddenBranch()
			}
		}
		filter.LocationIDs = narrowed
		filter.IsGlobal = actor.IsGlobal && in.LocationID == nil
		filter.VendorUserID = nil
	case domain.RoleVendor:
		vendorUserID := actor.ID
		filter.VendorUserID = &vendorUserID
		filter.LocationIDs = nil
	case domain.RoleSuperAdmin, domain.RoleDevSuperAdmin:
		// Global scope by role (the resolver always reports super_admin as
		// global, stash or not); the optional branch filter is the only
		// narrowing allowed.
		filter.IsGlobal = true
		if in.LocationID != nil {
			filter.LocationIDs = []domain.UUID{*in.LocationID}
			filter.IsGlobal = false
		}
	default:
		return nil, 0, domain.ForbiddenBranch()
	}
	if filter.Page < 1 {
		filter.Page = 1
	}
	if filter.Limit < 1 || filter.Limit > maxListLimit {
		filter.Limit = defaultListLimit
	}
	visits, total, err := s.visits.List(ctx, filter)
	if err != nil {
		return nil, 0, err
	}
	// File links are exchanged per row AFTER the scoped repository query, so
	// the filter above stays the single authz point: no new scope check here.
	// See withFileLinks for the per-row HMAC cost note.
	for i := range visits {
		visits[i] = s.withFileLinks(ctx, visits[i])
	}
	return visits, total, nil
}
