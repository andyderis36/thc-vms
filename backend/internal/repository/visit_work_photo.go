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
// upsert on UNIQUE (visit_request_id, kind) and bind the row to one visit_logs
// cycle via visit_log_id (migration 000034). The UNIQUE anchor is untouched:
// a re-attach replaces the row and rebinds it to the current cycle. The row
// lock serialises a concurrent check-out behind this transaction (or the
// reverse), so a photo can never land after the visit completed: the loser of
// the race re-reads the fresh status under its own lock and is refused.
//
// A nil visitLogID resolves to the latest 'in' log of the visit (NULL when
// the visit has no log row yet); an explicit id must belong to the same
// visit, otherwise the attach is a 422. The visit_log_id column predates this
// writer (migration 000034 is purely additive), so the upsert itself stays on
// the generated query and only the binding travels via raw SQL.
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
	visitLogID *domain.UUID,
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
		bound, err := resolveWorkPhotoLog(ctx, tx, parsed, visitLogID)
		if err != nil {
			return err
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
		if _, err := tx.Exec(ctx, `UPDATE visit_work_photo SET visit_log_id = $3 WHERE visit_request_id = $1 AND kind = $2`, parsed, string(kind), bound); err != nil {
			return MapError(err)
		}
		name, _ := resolveUserName(ctx, q, uploadedBy)
		photo, err = workPhotoToDomain(row.ID, row.VisitRequestID, row.Kind, row.Url, row.UploadedBy, row.CreatedAt, name, domainUUIDPtr(bound))
		return err
	}); err != nil {
		return domain.WorkPhoto{}, false, err
	}
	return photo, created, nil
}

// resolveWorkPhotoLog maps the requested cycle binding onto a NULL-safe
// visit_log_id for the UPDATE above. An explicit id must name a visit_logs row
// of THIS visit (foreign or unknown ids are 422, never silently rebound); a
// nil request takes the latest 'in' entry so an uploader that does not track
// cycles still lands on the active one, or NULL when the visit has no log row
// yet (status visiting without a gate entry is possible on legacy rows).
func resolveWorkPhotoLog(ctx context.Context, tx pgx.Tx, visitID uuid.UUID, requested *domain.UUID) (pgtype.UUID, error) {
	if requested != nil {
		parsed, err := fromDomainUUID(*requested)
		if err != nil {
			return pgtype.UUID{}, err
		}
		var owner uuid.UUID
		if err := tx.QueryRow(ctx, `SELECT visit_request_id FROM visit_logs WHERE id = $1`, parsed).Scan(&owner); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return pgtype.UUID{}, domain.ValidationFailure("Siklus kunjungan (visit_log_id) tidak dikenal.")
			}
			return pgtype.UUID{}, MapError(err)
		}
		if owner != visitID {
			return pgtype.UUID{}, domain.ValidationFailure("Siklus kunjungan (visit_log_id) bukan milik kunjungan ini.")
		}
		return pgtype.UUID{Bytes: parsed, Valid: true}, nil
	}
	var latest uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT id FROM visit_logs WHERE visit_request_id = $1 AND direction = 'in' ORDER BY created_at DESC, id DESC LIMIT 1`, visitID).Scan(&latest); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return pgtype.UUID{}, nil
		}
		return pgtype.UUID{}, MapError(err)
	}
	return pgtype.UUID{Bytes: latest, Valid: true}, nil
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
	// visit_log_id travels outside the generated row (the select predates
	// migration 000034), so it is overlaid here keyed by photo id.
	bound := make(map[uuid.UUID]*domain.UUID, len(rows))
	if logRows, err := r.pool.Query(ctx, `SELECT id, visit_log_id FROM visit_work_photo WHERE visit_request_id = $1`, parsed); err != nil {
		return nil, MapError(err)
	} else {
		defer logRows.Close()
		for logRows.Next() {
			var id uuid.UUID
			var logID pgtype.UUID
			if err := logRows.Scan(&id, &logID); err != nil {
				return nil, MapError(err)
			}
			bound[id] = domainUUIDPtr(logID)
		}
		if err := logRows.Err(); err != nil {
			return nil, MapError(err)
		}
	}
	out := make([]domain.WorkPhoto, 0, len(rows))
	for _, row := range rows {
		photo, err := workPhotoToDomain(row.ID, row.VisitRequestID, row.Kind, row.Url, row.UploadedBy, row.CreatedAt, row.UploadedByName, bound[row.ID])
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
	visitLogID *domain.UUID,
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
		VisitLogID:     visitLogID,
	}, nil
}
