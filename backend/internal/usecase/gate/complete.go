package gate

import (
	"context"
	"fmt"

	"thc-vms/backend/internal/domain"
)

// authorizeCompletionRole admits only the staff roles allowed to close a
// permit by hand: the branch admin and the national bypass. Security executes
// gate scans but never completes a permit; vendors are external accounts.
func authorizeCompletionRole(role domain.RoleName) error {
	if role == domain.RoleAdmin || domain.IsSuperAdminRole(role) {
		return nil
	}
	return domain.Forbidden("Hanya admin atau super_admin yang dapat menyelesaikan kunjungan.")
}

// CompleteVisit is the manual "Selesaikan" action: an admin (or a superadmin
// with the national bypass) of the visit's branch closes an active permit from
// visiting or offsite, at any time. The human actor id flows into UpdateStatus,
// so the repository resolves the actor's name and Indonesian role label via
// resolveUserDisplay and emits the ordinary completed template — never the
// System/(Otomatis) marking, which stays exclusive to worker rule R3.
func (s *Service) CompleteVisit(ctx context.Context, actor Actor, visitID domain.UUID) error {
	visit, err := s.visits.FindByID(ctx, visitID)
	if err != nil {
		return domain.NotFoundEntity("Kunjungan")
	}
	if err := authorizeCompletionRole(actor.Role); err != nil {
		return err
	}
	if err := authorizeBranch(actor, visit); err != nil {
		s.logger.Debug("complete refused: cross-branch scan",
			"visit_id", visit.ID, "visit_location", visit.LocationID, "actor", actor.ID)
		return err
	}
	if visit.Status != domain.VisitStatusVisiting && visit.Status != domain.VisitStatusOffsite {
		return domain.Conflict(fmt.Sprintf("Kunjungan berstatus %q tidak dapat diselesaikan.", string(visit.Status)))
	}
	return s.visits.UpdateStatus(ctx, visit.ID, domain.VisitStatusCompleted, actor.ID, "")
}
