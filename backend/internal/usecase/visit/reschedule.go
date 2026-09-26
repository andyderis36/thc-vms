package visit

import (
	"context"
	"strings"
	"time"

	"thc-vms/backend/internal/domain"
)

// Reschedule moves the visit window and flips the visit to rescheduled in one
// atomic repository call.
//
// PROMINENT CONTRACT: the visit lands in rescheduled, NOT in visiting, and it
// must be re-approved by an admin before check-in, because the domain state
// machine forbids the rescheduled -> visiting edge by omission. The gate agent
// owns check-in; this usecase never writes visiting.
func (s *Service) Reschedule(ctx context.Context, actor Actor, visitID domain.UUID, start time.Time, end time.Time, reason string) error {
	if err := validateWindow(start, end); err != nil {
		return err
	}
	if strings.TrimSpace(reason) == "" {
		return domain.ValidationFailure("Alasan penjadwalan ulang wajib diisi.")
	}
	visit, err := s.visits.FindByID(ctx, visitID)
	if err != nil {
		return err
	}
	if err := actor.requireRole(domain.RolePIC, domain.RoleAdmin, domain.RoleSuperAdmin); err != nil {
		return err
	}
	switch actor.Role {
	case domain.RolePIC:
		if visit.PICUserID != actor.ID {
			return domain.NotFoundEntity("Kunjungan")
		}
	case domain.RoleAdmin:
		if err := actor.requireBranch(visit.LocationID); err != nil {
			return err
		}
	case domain.RoleSuperAdmin:
	default:
		return domain.ForbiddenBranch()
	}
	// The repository flips the status to rescheduled; pre-check the edge so a
	// visit that cannot be rescheduled (e.g. a terminal one) fails here with
	// zero repository writes.
	if err := domain.CanTransition(visit.Status, domain.VisitStatusRescheduled); err != nil {
		return err
	}
	return s.visits.Reschedule(ctx, visit.ID, start, end, actor.ID, strings.TrimSpace(reason))
}
