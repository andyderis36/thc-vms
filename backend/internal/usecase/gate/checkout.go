package gate

import (
	"context"
	"fmt"

	"thc-vms/backend/internal/domain"
)

// CheckOut executes the gate check-out. Same actor and branch rules as
// check-in; the visit must be visiting. There is deliberately NO window check:
// the +/-2h tolerance is a check-in rule only. Writes run RecordCheckOut
// first, then UpdateStatus to completed.
func (s *Service) CheckOut(ctx context.Context, actor Actor, visitID domain.UUID) (domain.CheckOut, error) {
	visit, err := s.visits.FindByID(ctx, visitID)
	if err != nil {
		return domain.CheckOut{}, domain.NotFoundEntity("Kunjungan")
	}
	if err := authorizeGateRole(actor.Role); err != nil {
		return domain.CheckOut{}, err
	}
	if err := authorizeBranch(actor, visit); err != nil {
		s.logger.Debug("check-out refused: cross-branch scan",
			"visit_id", visit.ID, "visit_location", visit.LocationID, "actor", actor.ID)
		return domain.CheckOut{}, err
	}
	if visit.Status != domain.VisitStatusVisiting {
		return domain.CheckOut{}, domain.Conflict(
			fmt.Sprintf("Kunjungan berstatus %q tidak dapat di-check-out.", string(visit.Status)))
	}
	if err := domain.CanTransition(visit.Status, domain.VisitStatusCompleted); err != nil {
		return domain.CheckOut{}, err
	}
	now := s.clock.Now()
	recorded, err := s.checkIns.RecordCheckOut(ctx, domain.CheckOut{
		VisitRequestID: visit.ID,
		CheckedOutAt:   now,
		CheckedOutBy:   actor.ID,
	})
	if err != nil {
		return domain.CheckOut{}, err
	}
	if err := s.visits.UpdateStatus(ctx, visit.ID, domain.VisitStatusCompleted, actor.ID, ""); err != nil {
		return domain.CheckOut{}, err
	}
	return recorded, nil
}
