package visit

import (
	"context"
	"strings"

	"thc-vms/backend/internal/domain"
)

// Approve moves a requested visit to approved. Only a branch admin (for its
// own branch) or super_admin may trigger this edge; security and vendor are
// refused with 403.
func (s *Service) Approve(ctx context.Context, actor Actor, visitID domain.UUID, note string) error {
	visit, err := s.visits.FindByID(ctx, visitID)
	if err != nil {
		return err
	}
	if err := actor.requireRole(domain.RoleAdmin, domain.RoleSuperAdmin); err != nil {
		return err
	}
	if err := actor.requireBranch(visit.LocationID); err != nil {
		return err
	}
	return s.transition(ctx, visit, actor, domain.VisitStatusApproved, note)
}

// Reject moves a requested visit to rejected. Only a branch admin (for its own
// branch) or super_admin may trigger this edge, and the rejection reason is
// mandatory: non-empty after trimming and at least 5 characters. The reason is
// stored as the history note.
func (s *Service) Reject(ctx context.Context, actor Actor, visitID domain.UUID, reason string) error {
	trimmed := strings.TrimSpace(reason)
	if trimmed == "" {
		return domain.ValidationFailure("Alasan penolakan wajib diisi.")
	}
	if len([]rune(trimmed)) < 5 {
		return domain.ValidationFailure("Alasan penolakan minimal 5 karakter.")
	}
	visit, err := s.visits.FindByID(ctx, visitID)
	if err != nil {
		return err
	}
	if err := actor.requireRole(domain.RoleAdmin, domain.RoleSuperAdmin); err != nil {
		return err
	}
	if err := actor.requireBranch(visit.LocationID); err != nil {
		return err
	}
	return s.transition(ctx, visit, actor, domain.VisitStatusRejected, trimmed)
}

// Cancel moves a visit to cancelled. The owning vendor, the branch admin and
// super_admin may trigger this edge; security and a vendor that does not own the
// visit are refused.
func (s *Service) Cancel(ctx context.Context, actor Actor, visitID domain.UUID, note string) error {
	visit, err := s.visits.FindByID(ctx, visitID)
	if err != nil {
		return err
	}
	if err := actor.requireRole(domain.RoleVendor, domain.RoleAdmin, domain.RoleSuperAdmin); err != nil {
		return err
	}
	switch actor.Role {
	case domain.RoleVendor:
		if visit.VendorUserID != actor.ID {
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
	return s.transition(ctx, visit, actor, domain.VisitStatusCancelled, note)
}

// transition is the shared tail of every lifecycle edge: it asks the domain
// state machine whether the move is legal and only then performs the single
// repository write. Every role and branch guard therefore runs before any
// write, so a refused transition records zero repository writes.
func (s *Service) transition(ctx context.Context, visit domain.VisitRequest, actor Actor, to domain.VisitStatus, note string) error {
	if err := domain.CanTransition(visit.Status, to); err != nil {
		return err
	}
	return s.visits.UpdateStatus(ctx, visit.ID, to, actor.ID, note)
}
