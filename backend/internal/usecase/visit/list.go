package visit

import (
	"context"
	"time"

	"thc-vms/backend/internal/domain"
)

// List limits: the default page size and the hard cap callers may request.
const (
	defaultListLimit = 20
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
	From   *time.Time
	To     *time.Time
	Page   int
	Limit  int
	// LocationID narrows the result to one branch. Honoured only for
	// super_admin; ignored for admin, security and pic.
	LocationID *domain.UUID
}

// ListVisits builds the domain.VisitFilter from the actor. This mapping IS the
// multi-branch isolation core and it is total: admin and security see only
// their own branch, pic sees only its own visits, super_admin sees everything
// unless it narrows by branch, and any unknown role is refused.
func (s *Service) ListVisits(ctx context.Context, actor Actor, in ListVisitsInput) ([]domain.VisitRequest, int64, error) {
	filter := domain.VisitFilter{
		Status: in.Status,
		From:   in.From,
		To:     in.To,
		Page:   in.Page,
		Limit:  in.Limit,
	}
	switch actor.Role {
	case domain.RoleAdmin, domain.RoleSecurity:
		// The actor's branch is assigned unconditionally, overwriting any
		// caller-supplied LocationID: isolation must not be negotiable by query
		// parameter.
		filter.LocationID = actor.LocationID
		filter.PICUserID = nil
	case domain.RolePIC:
		picID := actor.ID
		filter.PICUserID = &picID
		filter.LocationID = nil
	case domain.RoleSuperAdmin:
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
	return s.visits.List(ctx, filter)
}
