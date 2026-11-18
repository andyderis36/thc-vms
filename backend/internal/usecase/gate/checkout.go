package gate

import (
	"context"
	"errors"
	"fmt"

	"thc-vms/backend/internal/domain"
)

// CheckOut executes the gate check-out. Same actor and branch rules as
// check-in; the visit must be visiting. There is deliberately NO window check:
// the team may still be on site past end_date, and R3/Selesaikan closes the
// permit. A check-out moves the permit to offsite (not completed) so the team
// can re-enter; ResolveGateTransition is the single state guard. Writes run
// RecordCheckOut first, then UpdateStatus to offsite.
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
	next, ok := domain.ResolveGateTransition(visit.Status, domain.GateActionCheckOut)
	if !ok {
		return domain.CheckOut{}, domain.Conflict(
			fmt.Sprintf("Kunjungan berstatus %q tidak dapat di-check-out.", string(visit.Status)))
	}
	now := s.clock.Now()
	recorded, err := s.checkIns.RecordCheckOut(ctx, domain.CheckOut{
		VisitRequestID: visit.ID,
		CheckedOutAt:   now,
		CheckedOutBy:   actor.ID,
	})
	if err != nil {
		if !errors.Is(err, domain.ErrConflict) {
			return domain.CheckOut{}, err
		}
		// A subsequent cycle repeats a check-out: the first cycle already
		// wrote the row under the legacy UNIQUE(visit_request_id). Reuse it,
		// but still move the permit to offsite below. Same-direction double
		// scans are refused earlier by the state guard, not here.
		recorded, err = s.checkIns.FindCheckOutByVisit(ctx, visit.ID)
		if err != nil {
			return domain.CheckOut{}, err
		}
	}
	if err := s.visits.UpdateStatus(ctx, visit.ID, next, actor.ID, ""); err != nil {
		return domain.CheckOut{}, err
	}
	return recorded, nil
}
