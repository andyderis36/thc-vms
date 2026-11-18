package repository

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/repository/db"
)

// AttachWorkPhoto stores one before/after work proof in ONE transaction: lock
// via GetVisitByIDForUpdate, refuse any status but visiting with a 409, then
// upsert on UNIQUE (visit_request_id, kind). The row lock serialises a
// concurrent check-out behind this transaction (or the reverse), so a photo
// can never land after the visit completed: the loser of the race re-reads
// the fresh status under its own lock and is refused.
//
// The returned bool reports whether the row was created (true, answer 201)
// or replaced (false, answer 200). The visit lock also serialises two
// concurrent attaches to the same visit, which keeps the flag exact: the
// second transaction sees the first one's committed row.
func (r *visitRepository) AttachWorkPhoto(
	ctx context.Context,
	visitID domain.UUID,
	kind domain.WorkPhotoKind,
	url string,
	uploadedBy domain.UUID,
) (domain.WorkPhoto, bool, error) {
	if kind != domain.WorkPhotoBefore && kind != domain.WorkPhotoAfter {
		return domain.WorkPhoto{}, false, domain.ValidationFailure("Jenis bukti pengerjaan tidak dikenal.")
	}
	parsed, err := fromDomainUUID(visitID)
	if err != nil {
		return domain.WorkPhoto{}, false, err
	}
	actor, err := pgNullUUID(uploadedBy)
	if err != nil {
		return domain.WorkPhoto{}, false, err
	}
	var photo domain.WorkPhoto
	var created bool
	if err := WithTx(ctx, r.pool, func(tx pgx.Tx) error {
		q := db.New(r.pool).WithTx(tx)
		locked, err := q.GetVisitByIDForUpdate(ctx, db.GetVisitByIDForUpdateParams{ID: parsed})
		if err != nil {
			return MapError(err)
		}
		if locked.Status != string(domain.VisitStatusVisiting) {
			return workPhotoStatusConflict(locked.Status)
		}
		_, err = q.GetWorkPhoto(ctx, db.GetWorkPhotoParams{
			VisitRequestID: parsed,
			Kind:           string(kind),
		})
		switch {
		case err == nil:
			created = false
		case errors.Is(err, pgx.ErrNoRows):
			created = true
		default:
			return MapError(err)
		}
		row, err := q.UpsertWorkPhoto(ctx, db.UpsertWorkPhotoParams{
			VisitRequestID: parsed,
			Kind:           string(kind),
			Url:            url,
			UploadedBy:     actor,
		})
		if err != nil {
			return MapError(err)
		}
		name, _ := resolveUserName(ctx, q, uploadedBy)
		photo, err = workPhotoToDomain(row.ID, row.VisitRequestID, row.Kind, row.Url, row.UploadedBy, row.CreatedAt, name)
		return err
	}); err != nil {
		return domain.WorkPhoto{}, false, err
	}
	return photo, created, nil
}

// ListWorkPhotos returns both work proofs of one visit with the uploader
// display names resolved via the users join. A visit without proofs yields an
// empty slice, never nil, so callers can range over it directly.
func (r *visitRepository) ListWorkPhotos(ctx context.Context, visitID domain.UUID) ([]domain.WorkPhoto, error) {
	parsed, err := fromDomainUUID(visitID)
	if err != nil {
		return nil, err
	}
	rows, err := db.New(r.pool).ListWorkPhotosByVisit(ctx, db.ListWorkPhotosByVisitParams{VisitRequestID: parsed})
	if err != nil {
		return nil, MapError(err)
	}
	out := make([]domain.WorkPhoto, 0, len(rows))
	for _, row := range rows {
		photo, err := workPhotoToDomain(row.ID, row.VisitRequestID, row.Kind, row.Url, row.UploadedBy, row.CreatedAt, row.UploadedByName)
		if err != nil {
			return nil, err
		}
		out = append(out, photo)
	}
	return out, nil
}

// workPhotoStatusConflict refuses a work-proof attach outside the execution
// window with a 409 carrying the concrete reason: before check-in the visit
// has not started yet, after completion it is already closed.
func workPhotoStatusConflict(status string) error {
	if domain.IsTerminal(domain.VisitStatus(status)) {
		return domain.Conflict("Kunjungan sudah selesai (status " + status + "); bukti pengerjaan tidak dapat dilampirkan lagi.")
	}
	return domain.Conflict("Bukti pengerjaan hanya dapat dilampirkan saat kunjungan sedang berlangsung (status kunjungan saat ini: " + status + ").")
}

// workPhotoToDomain projects one visit_work_photo row onto the domain proof.
// The kind column is CHECK-constrained to the closed vocabulary, so a parse
// failure here can only mean schema drift and is reported as a storage error.
func workPhotoToDomain(
	id uuid.UUID,
	visitID uuid.UUID,
	kind string,
	url string,
	uploadedBy pgtype.UUID,
	uploadedAt time.Time,
	uploadedByName string,
) (domain.WorkPhoto, error) {
	parsed, err := domain.ParseWorkPhotoKind(kind)
	if err != nil {
		return domain.WorkPhoto{}, err
	}
	return domain.WorkPhoto{
		ID:             mustDomainUUID(id),
		VisitRequestID: mustDomainUUID(visitID),
		Kind:           parsed,
		URL:            url,
		UploadedBy:     domainUUIDPtr(uploadedBy),
		UploadedByName: uploadedByName,
		UploadedAt:     uploadedAt,
	}, nil
}
