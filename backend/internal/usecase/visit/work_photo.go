package visit

import (
	"context"
	"log/slog"
	"strings"

	"thc-vms/backend/internal/domain"
)

// authorizeWorkPhotoWrite applies the attach scope of
// POST /visits/:id/work-photos: the owning vendor (role vendor AND id ==
// visit.VendorUserID, anything else 404 so a foreign vendor learns nothing),
// or the visit creator (visit.CreatedBy == actor id) for admin and
// super_admin. Security never attaches: gate staff only verifies check-in/out
// at the scanner, so any security attach is 403. An admin must additionally
// pass branch isolation (403 outside the branch); a legacy visit without
// CreatedBy admits no admin attach (fail closed).
func authorizeWorkPhotoWrite(actor Actor, visit domain.VisitRequest) error {
	switch actor.Role {
	case domain.RoleVendor:
		if visit.VendorUserID != actor.ID {
			return domain.NotFoundEntity("Kunjungan")
		}
		return nil
	case domain.RoleAdmin:
		if err := actor.requireBranchAccess(visit.LocationID); err != nil {
			return err
		}
		if visit.CreatedBy == nil || *visit.CreatedBy != actor.ID {
			return domain.ForbiddenBranch()
		}
		return nil
	case domain.RoleSecurity:
		return domain.ForbiddenBranch()
	case domain.RoleSuperAdmin, domain.RoleDevSuperAdmin:
		if visit.CreatedBy == nil || *visit.CreatedBy != actor.ID {
			return domain.ForbiddenBranch()
		}
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
func (s *Service) AttachWorkPhoto(ctx context.Context, actor Actor, visitID domain.UUID, kind, url string, visitLogID *domain.UUID) (domain.WorkPhoto, bool, error) {
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
	// Remember the currently stored URL so a replacement can delete the
	// orphaned object afterwards: the upsert below overwrites the row, and
	// neither the reaper (pending/-only scope) nor the visit purge would
	// ever see the old key again. A lookup failure degrades to no cleanup
	// (fail open on the delete, never on the write).
	previousURL := ""
	if s.storage != nil {
		if existing, err := s.visits.ListWorkPhotos(ctx, visit.ID); err == nil {
			for _, photo := range existing {
				if photo.Kind == parsed {
					previousURL = strings.TrimSpace(photo.URL)
				}
			}
		}
	}
	photo, created, err := s.visits.AttachWorkPhoto(ctx, visit.ID, parsed, trimmed, actor.ID, visitLogID)
	if err != nil {
		return domain.WorkPhoto{}, false, err
	}
	s.deleteReplacedWorkPhoto(ctx, previousURL, trimmed)
	return photo, created, nil
}

// deleteReplacedWorkPhoto removes the previous slot object after a
// replacement attach. Best-effort: a nil storage, an unresolvable URL, the
// same URL re-attached, or a delete failure only skips/logs — the committed
// write already stands and the leftover stays reaper-visible, never a
// dangling reference.
func (s *Service) deleteReplacedWorkPhoto(ctx context.Context, previousURL, currentURL string) {
	if s.storage == nil || previousURL == "" || previousURL == currentURL {
		return
	}
	key, err := s.storage.ObjectKeyFromStoredURL(previousURL)
	if err != nil || key == "" {
		slog.Warn("visit: replaced work photo kept: unresolvable previous URL", "error", err)
		return
	}
	if err := s.storage.DeleteObject(ctx, key); err != nil {
		slog.Warn("visit: replaced work photo delete failed", "key", key, "error", err)
	}
}
