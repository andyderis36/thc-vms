package gate

import (
	"context"
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
// then the writes (UpdateStatus to visiting, then RecordCheckIn).
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
	if visit.Status != domain.VisitStatusApproved {
		return domain.CheckIn{}, rescheduledOrStateConflict(visit.Status)
	}
	now := s.clock.Now()
	if side := CheckInWindowSide(visit.StartDate, visit.EndDate, now); side != WindowOpen {
		s.logger.Debug("check-in refused: outside tolerance window",
			"visit_id", visit.ID, "side", string(side))
		return domain.CheckIn{}, domain.CheckInWindowExceeded()
	}
	if err := domain.CanTransition(visit.Status, domain.VisitStatusVisiting); err != nil {
		return domain.CheckIn{}, err
	}
	// Gate photo is optional, but a supplied photo_url travels the same
	// upload allowlist as the visit payload (https, or http for dev MinIO).
	if in.PhotoURL != nil {
		if err := visituc.ValidatePhotoURL(*in.PhotoURL); err != nil {
			return domain.CheckIn{}, err
		}
	}
	if err := s.visits.UpdateStatus(ctx, visit.ID, domain.VisitStatusVisiting, actor.ID, in.Notes); err != nil {
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
		return domain.CheckIn{}, err
	}
	return recorded, nil
}

// rescheduledOrStateConflict refuses every non-approved state. A rescheduled
// visit names its way out (re-approval first: rescheduled->visiting is
// forbidden by omission), other states name the offending status.
func rescheduledOrStateConflict(status domain.VisitStatus) error {
	if status == domain.VisitStatusRescheduled {
		return domain.Conflict("Kunjungan dijadwalkan ulang dan harus disetujui kembali sebelum check-in.")
	}
	return domain.Conflict(fmt.Sprintf("Kunjungan berstatus %q tidak dapat di-check-in.", string(status)))
}
