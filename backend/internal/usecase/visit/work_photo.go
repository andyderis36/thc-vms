package visit

import (
	"context"
	"strings"

	"thc-vms/backend/internal/domain"
)

// authorizeWorkPhotoWrite applies the attach scope of
// POST /visits/:id/work-photos: the owning vendor (role vendor AND id ==
// visit.VendorUserID, anything else 404 so a foreign vendor learns nothing),
// branch isolation for admin/security (403 outside the branch), global for
// super_admin. No other role may attach.
func authorizeWorkPhotoWrite(actor Actor, visit domain.VisitRequest) error {
	switch actor.Role {
	case domain.RoleVendor:
		if visit.VendorUserID != actor.ID {
			return domain.NotFoundEntity("Kunjungan")
		}
		return nil
	case domain.RoleAdmin, domain.RoleSecurity:
		return actor.requireBranchAccess(visit.LocationID)
	case domain.RoleSuperAdmin, domain.RoleDevSuperAdmin:
		return nil
	default:
		return domain.ForbiddenBranch()
	}
}

// AttachWorkPhoto stores one before/after work proof for a visit that is
// being executed (POST /visits/:id/work-photos). Guards run in the exact
// order the HTTP status depends on: resolve -> role/ownership -> kind/url
// validation, and only then the repository write. The write itself re-checks
// the visiting status inside the row-locked transaction, so a check-out that
// lands between this read and the write is still refused with 409.
//
// The returned bool reports whether the row was created (true, the handler
// answers 201) or replaced (false, the handler answers 200).
func (s *Service) AttachWorkPhoto(ctx context.Context, actor Actor, visitID domain.UUID, kind, url string) (domain.WorkPhoto, bool, error) {
	visit, err := s.visits.FindByID(ctx, visitID)
	if err != nil {
		return domain.WorkPhoto{}, false, err
	}
	if err := authorizeWorkPhotoWrite(actor, visit); err != nil {
		return domain.WorkPhoto{}, false, err
	}
	parsed, err := domain.ParseWorkPhotoKind(strings.TrimSpace(kind))
	if err != nil {
		return domain.WorkPhoto{}, false, domain.ValidationFailure("Jenis bukti pengerjaan tidak dikenal: harus \"before\" atau \"after\".")
	}
	trimmed := strings.TrimSpace(url)
	if trimmed == "" {
		return domain.WorkPhoto{}, false, domain.ValidationFailure("URL bukti pengerjaan wajib diisi.")
	}
	// A supplied proof travels the same upload allowlist as the visit payload
	// (https, or http for the dev hosts and the configured storage hosts).
	if err := s.validatePhotoURL(trimmed); err != nil {
		return domain.WorkPhoto{}, false, err
	}
	return s.visits.AttachWorkPhoto(ctx, visit.ID, parsed, trimmed, actor.ID)
}
