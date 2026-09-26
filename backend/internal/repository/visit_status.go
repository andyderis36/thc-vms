package repository

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/repository/db"
)

// UpdateStatus moves one visit to status and appends its history row in ONE
// transaction: lock via GetVisitByIDForUpdate, write via UpdateVisitStatus,
// audit via InsertStatusHistory. changed_by is SQL NULL when changedBy is the
// empty UUID (automatic transitions). Any failure rolls everything back, so a
// status change without its history row (or the reverse) is impossible.
//
// A move onto the status the visit already holds is refused with ErrConflict:
// the row lock serialises two concurrent approvals, the loser sees the fresh
// status and must not append a second history row for a transition that
// already happened.
func (r *visitRepository) UpdateStatus(
	ctx context.Context,
	id domain.UUID,
	status domain.VisitStatus,
	changedBy domain.UUID,
	notes string,
) error {
	if _, err := domain.ParseVisitStatus(string(status)); err != nil {
		return err
	}
	parsed, err := fromDomainUUID(id)
	if err != nil {
		return err
	}
	actor, err := pgNullUUID(changedBy)
	if err != nil {
		return err
	}
	return WithTx(ctx, r.pool, func(tx pgx.Tx) error {
		q := db.New(r.pool).WithTx(tx)
		locked, err := q.GetVisitByIDForUpdate(ctx, db.GetVisitByIDForUpdateParams{ID: parsed})
		if err != nil {
			return MapError(err)
		}
		if locked.Status == string(status) {
			return fmt.Errorf("repository: visit %s already %s: %w", id, status, domain.ErrConflict)
		}
		if _, err := q.UpdateVisitStatus(ctx, db.UpdateVisitStatusParams{
			ID:     parsed,
			Status: string(status),
		}); err != nil {
			return MapError(err)
		}
		if _, err := q.InsertStatusHistory(ctx, db.InsertStatusHistoryParams{
			VisitRequestID: parsed,
			Status:         string(status),
			ChangedBy:      actor,
			Notes:          pgText(notePtr(notes)),
		}); err != nil {
			return MapError(err)
		}
		return nil
	})
}

// Reschedule writes the new window, flips the status to rescheduled and
// appends the history row atomically; reason is stored as the history note.
// A reversed window is rejected by the database CHECK as well as by request
// validation, and the rollback keeps the old window intact.
func (r *visitRepository) Reschedule(
	ctx context.Context,
	id domain.UUID,
	start time.Time,
	end time.Time,
	changedBy domain.UUID,
	reason string,
) error {
	parsed, err := fromDomainUUID(id)
	if err != nil {
		return err
	}
	actor, err := pgNullUUID(changedBy)
	if err != nil {
		return err
	}
	return WithTx(ctx, r.pool, func(tx pgx.Tx) error {
		q := db.New(r.pool).WithTx(tx)
		if _, err := q.GetVisitByIDForUpdate(ctx, db.GetVisitByIDForUpdateParams{ID: parsed}); err != nil {
			return MapError(err)
		}
		if _, err := q.UpdateVisitSchedule(ctx, db.UpdateVisitScheduleParams{
			ID:        parsed,
			StartDate: start,
			EndDate:   end,
			Status:    string(domain.VisitStatusRescheduled),
		}); err != nil {
			return MapError(err)
		}
		if _, err := q.InsertStatusHistory(ctx, db.InsertStatusHistoryParams{
			VisitRequestID: parsed,
			Status:         string(domain.VisitStatusRescheduled),
			ChangedBy:      actor,
			Notes:          pgText(notePtr(reason)),
		}); err != nil {
			return MapError(err)
		}
		return nil
	})
}

// notePtr maps an empty note to NULL so history rows carry a note only when
// the actor actually wrote one.
func notePtr(note string) *string {
	if note == "" {
		return nil
	}
	return &note
}
