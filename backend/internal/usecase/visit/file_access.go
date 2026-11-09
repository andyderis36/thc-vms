package visit

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"thc-vms/backend/internal/domain"
)

// FileKind selects which stored file slot ResolveFileStream serves: the SPK
// assignment letter on the visit row, one visitor's KTP photo / selfie, or
// one before/after work proof from the visit_work_photo table.
type FileKind string

const (
	FileKindAssignmentLetter FileKind = "assignment_letter"
	FileKindIDCard           FileKind = "id_card"
	FileKindSelfie           FileKind = "selfie"
	// FileKindWorkBefore serves the "before" work proof: the site condition
	// the vendor photographed before starting the job.
	FileKindWorkBefore FileKind = "work_before"
	// FileKindWorkAfter serves the "after" work proof: the site condition
	// after the job finished.
	FileKindWorkAfter FileKind = "work_after"
)

// ObjectStream is the resolved, ready-to-serve file payload for one slot: the
// open bucket stream plus the headers the HTTP layer serves it with. The body
// streams straight from storage (never buffered whole); the handler owns
// closing Content.
type ObjectStream struct {
	Content     io.ReadCloser
	Size        int64
	ContentType string
	FileName    string
	ModTime     time.Time
}

// WithObjectReader wires the object-storage read port and returns the service
// for chaining at the composition root, mirroring WithFileLinks. A nil reader
// fails reads closed (404) rather than leaking raw private-bucket addresses.
func (s *Service) WithObjectReader(reader domain.ObjectReader) *Service {
	s.objectReader = reader
	return s
}

// authorizeVisitRead applies the read scope shared by GetVisit and
// ResolveFileStream: global for super_admin, branch isolation for
// admin/security, ownership for vendor. There is deliberately ONE predicate:
// whoever may see the visit may stream its files, and a caller refused the
// visit never reaches storage at all.
func authorizeVisitRead(actor Actor, visit domain.VisitRequest) error {
	switch actor.Role {
	case domain.RoleSuperAdmin, domain.RoleDevSuperAdmin:
		return nil
	case domain.RoleAdmin, domain.RoleSecurity:
		return actor.requireBranchAccess(visit.LocationID)
	case domain.RoleVendor:
		if visit.VendorUserID != actor.ID {
			return domain.NotFoundEntity("Kunjungan")
		}
		return nil
	default:
		return domain.ForbiddenBranch()
	}
}

// fileNotFound is the fail-closed 404 for every unreadable slot: empty,
// foreign, tampered or unknown. It wraps ErrNotFound so errors.Is keeps
// working while the message never discloses whether the visit exists.
func fileNotFound() error {
	return &domain.AppError{
		Status:  http.StatusNotFound,
		Code:    "NOT_FOUND",
		Message: "Berkas tidak tersedia.",
		Err:     domain.ErrNotFound,
	}
}

// selectFileSlot resolves the stored URL for one slot: the assignment letter
// lives on the visit row, the KTP photo and selfie live on the matching
// visitor row, and the work proofs live in the visit_work_photo table (read
// raw here so ObjectKeyFromStoredURL can reverse them; the presigned detail
// member is a separate path). A nil result means "no such slot"; a repository
// failure propagates as a 500 so a work-photo-table outage is visible
// instead of masquerading as a missing file.
func (s *Service) selectFileSlot(ctx context.Context, visit domain.VisitRequest, kind FileKind, visitorID domain.UUID) (*string, error) {
	switch kind {
	case FileKindAssignmentLetter:
		return visit.AssignmentLetterURL, nil
	case FileKindIDCard, FileKindSelfie:
		for i := range visit.Visitors {
			if visit.Visitors[i].ID != visitorID {
				continue
			}
			if kind == FileKindIDCard {
				return visit.Visitors[i].IDCardPhotoURL, nil
			}
			return visit.Visitors[i].PhotoURL, nil
		}
		return nil, nil
	case FileKindWorkBefore, FileKindWorkAfter:
		photos, err := s.visits.ListWorkPhotos(ctx, visit.ID)
		if err != nil {
			return nil, err
		}
		for i := range photos {
			if kind == FileKindWorkBefore && photos[i].Kind == domain.WorkPhotoBefore ||
				kind == FileKindWorkAfter && photos[i].Kind == domain.WorkPhotoAfter {
				return &photos[i].URL, nil
			}
		}
		return nil, nil
	default:
		return nil, nil
	}
}

// fileNameOfKey derives the served file name from the object key tail, so the
// Content-Disposition never echoes a bucket path.
func fileNameOfKey(objectKey string) string {
	if i := strings.LastIndex(objectKey, "/"); i >= 0 {
		return objectKey[i+1:]
	}
	return objectKey
}

// ResolveFileStream resolves one file slot to a ready-to-serve stream for the
// scoped GET /visits/:id/file endpoint. The order is the security contract:
// load the visit, apply the GetVisit scope predicate FIRST (a refused caller
// never reaches storage), select the slot (an empty or unknown slot is 404
// without fetching), reverse the stored URL through the adapter's own-bucket
// rule (a foreign or tampered URL fails closed with 404, no fetch), then read.
// Raw stored URLs never leave this function: the caller gets bytes, not links.
func (s *Service) ResolveFileStream(ctx context.Context, actor Actor, visitID domain.UUID, kind FileKind, visitorID domain.UUID) (ObjectStream, error) {
	visit, err := s.visits.FindByID(ctx, visitID)
	if err != nil {
		return ObjectStream{}, err
	}
	if err := authorizeVisitRead(actor, visit); err != nil {
		return ObjectStream{}, err
	}
	raw, err := s.selectFileSlot(ctx, visit, kind, visitorID)
	if err != nil {
		return ObjectStream{}, err
	}
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return ObjectStream{}, fileNotFound()
	}
	if s.objectReader == nil {
		return ObjectStream{}, fileNotFound()
	}
	key, err := s.objectReader.ObjectKeyFromStoredURL(*raw)
	if err != nil {
		return ObjectStream{}, fileNotFound()
	}
	content, err := s.objectReader.OpenObject(ctx, key)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			return ObjectStream{}, fileNotFound()
		}
		return ObjectStream{}, err
	}
	return ObjectStream{
		Content:     content.Content,
		Size:        content.Size,
		ContentType: content.ContentType,
		FileName:    fileNameOfKey(key),
		ModTime:     content.ModTime,
	}, nil
}
