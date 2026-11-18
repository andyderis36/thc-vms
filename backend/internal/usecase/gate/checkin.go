package gate

import (
	"context"
	"errors"
	"fmt"

	"thc-vms/backend/internal/domain"
	visituc "thc-vms/backend/internal/usecase/visit"
)

// CheckInInput carries the optional gate artefacts. The flow diagram has no
// photo step, so PhotoURL, BadgeCode and Notes are all optional.
type CheckInInput struct {
	PhotoURL  *string
	BadgeCode *string
	Notes     string
}

// CheckIn executes the gate check-in. Guards run in the exact order the HTTP
// status depends on: resolve -> role -> branch -> state -> window, and only
// then the writes (UpdateStatus to visiting, then RecordCheckIn). A multi-entry
// permit admits both the first entry (approved) and a re-entry (offsite); the
// domain's ResolveGateTransition is the single guard for those two edges and
// refuses terminal states and same-direction double scans with a clean 4xx.
func (s *Service) CheckIn(ctx context.Context, actor Actor, visitIDOrCode string, in CheckInInput) (domain.CheckIn, error) {
	visit, err := s.resolveVisit(ctx, visitIDOrCode)
	if err != nil {
		return domain.CheckIn{}, err
	}
	if err := authorizeGateRole(actor.Role); err != nil {
		return domain.CheckIn{}, err
	}
	if err := authorizeBranch(actor, visit); err != nil {
		s.logger.Debug("check-in refused: cross-branch scan",
			"visit_id", visit.ID, "visit_location", visit.LocationID, "actor", actor.ID)
		return domain.CheckIn{}, err
	}
	next, ok := domain.ResolveGateTransition(visit.Status, domain.GateActionCheckIn)
	if !ok {
		return domain.CheckIn{}, rescheduledOrStateConflict(visit.Status)
	}
	now := s.clock.Now()
	if side := CheckInWindowSide(visit.StartDate, visit.EndDate, now); side != WindowOpen {
		s.logger.Debug("check-in refused: outside tolerance window",
			"visit_id", visit.ID, "side", string(side))
		return domain.CheckIn{}, domain.CheckInWindowExceeded()
	}
	// Gate photo is optional, but a supplied photo_url travels the same
	// upload allowlist as the visit payload (https, or http for dev MinIO).
	if in.PhotoURL != nil {
		if err := visituc.ValidatePhotoURL(*in.PhotoURL, s.trustedFileOrigins); err != nil {
			return domain.CheckIn{}, err
		}
	}
	if err := s.visits.UpdateStatus(ctx, visit.ID, next, actor.ID, in.Notes); err != nil {
		return domain.CheckIn{}, err
	}
	recorded, err := s.checkIns.RecordCheckIn(ctx, domain.CheckIn{
		VisitRequestID: visit.ID,
		CheckedInAt:    now,
		CheckedInBy:    actor.ID,
		PhotoURL:       in.PhotoURL,
		BadgeCode:      in.BadgeCode,
	})
	if err != nil {
		// Re-entry (offsite) legitimately repeats a check-in: the first entry
		// already wrote the row under the legacy UNIQUE(visit_request_id). The
		// state guard admitted this move, so reuse that row. A first entry
		// (approved) has no such row and must surface the conflict unchanged.
		if errors.Is(err, domain.ErrConflict) && visit.Status == domain.VisitStatusOffsite {
			return s.checkIns.FindCheckInByVisit(ctx, visit.ID)
		}
		return domain.CheckIn{}, err
	}
	return recorded, nil
}

// rescheduledOrStateConflict refuses every state ResolveGateTransition does
// not admit for check-in (only approved and offsite are). A rescheduled visit
// names its way out (re-approval first), other states name the offending status.
func rescheduledOrStateConflict(status domain.VisitStatus) error {
	if status == domain.VisitStatusRescheduled {
		return domain.Conflict("Kunjungan dijadwalkan ulang dan harus disetujui kembali sebelum check-in.")
	}
	return domain.Conflict(fmt.Sprintf("Kunjungan berstatus %q tidak dapat di-check-in.", string(status)))
}
