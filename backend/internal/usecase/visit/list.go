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
// LocationID is NOT a scope override: it is the optional NARROWING filter that
// only super_admin may use, because openapi documents `?location_id=` for the
// central-office view and PRD L109 grants superadmin the ability to filter by
// branch. For every other role the actor's own scope is authoritative and this
// value is ignored, so a caller can never widen their visibility.
type ListVisitsInput struct {
	Status *domain.VisitStatus
	// Search is the optional free-text filter (?q=); empty means unfiltered.
	Search string
	From   *time.Time
	To     *time.Time
	Page   int
	Limit  int
	// LocationID narrows the result to one branch. Honoured only for
	// super_admin; ignored for admin, security and vendor.
	LocationID *domain.UUID
	// SortBy/Order select the ORDER BY column and direction (?sort_by=,
	// ?order=). Empty means the legacy default (created_at desc); unknown
	// values are normalised to that default so they can never reach SQL.
	SortBy domain.VisitSortBy
	Order  domain.VisitSortOrder
}

// ListVisits builds the domain.VisitFilter from the actor. This mapping IS the
// multi-branch isolation core and it is total: admin and security see only
// their own branch, vendor sees only its own visits, super_admin sees everything
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
		// The actor's branch is assigned unconditionally, overwriting any
		// caller-supplied LocationID: isolation must not be negotiable by query
		// parameter.
		filter.LocationID = actor.LocationID
		filter.VendorUserID = nil
	case domain.RoleVendor:
		vendorUserID := actor.ID
		filter.VendorUserID = &vendorUserID
		filter.LocationID = nil
	case domain.RoleSuperAdmin, domain.RoleDevSuperAdmin:
		// Global scope; the optional branch filter is the only narrowing allowed.
		filter.LocationID = in.LocationID
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
