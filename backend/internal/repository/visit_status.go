package repository

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
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
	var pending *pendingEmail
	var locationID, vendorUserID uuid.UUID
	if err := WithTx(ctx, r.pool, func(tx pgx.Tx) error {
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
		locationID, vendorUserID = locked.LocationID, locked.VendorUserID
		first := domain.TransitionNotification(status, !actor.Valid, locked.VisitID)
		if err := emit(ctx, q, first, locked.ID, locked.LocationID, locked.VendorUserID, time.Now()); err != nil {
			return err
		}
		// A human-driven cancellation notifies the other side: the vendor
		// cancelling its own visit tells the branch staff, an admin or
		// superadmin cancelling tells the vendor. The worker (empty actor,
		// SQL NULL) keeps its visit_auto_cancelled row from the emit above.
		// byVendor compares the actor against the visit's vendor user: only
		// the owning vendor may cancel via the usecase guard, so equality
		// means a vendor-side cancel.
		if status == domain.VisitStatusCancelled && actor.Valid {
			byVendor := false
			if changer, err := fromDomainUUID(changedBy); err == nil && changer == locked.VendorUserID {
				byVendor = true
			}
			human := domain.HumanCancelledNotification(locked.VisitID, byVendor)
			if err := emit(ctx, q, human, locked.ID, locked.LocationID, locked.VendorUserID, time.Now()); err != nil {
				return err
			}
			pending = &pendingEmail{visit: emailVisit(locked, locked.StartDate, locked.EndDate, notes), tpl: human, audiences: []domain.NotificationAudience{human.Audience}}
		}
		if first != nil {
			pending = &pendingEmail{visit: emailVisit(locked, locked.StartDate, locked.EndDate, notes), tpl: first, audiences: []domain.NotificationAudience{first.Audience}}
		}
		// A pending vendor leg needs the roster for the member fan-out: load
		// it inside the same transaction so the email sees the snapshot the
		// in_app rows were written from. Staff-only moves (gate check-in/out)
		// skip the extra lookup.
		if pending != nil && hasVendorAudience(pending.audiences) {
			if err := attachMembers(ctx, q, parsed, pending); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		return err
	}
	// The transaction committed: fan the single captured email out. A
	// rolled-back transaction returns above with no pending email, so it
	// enqueues zero. enqueueEmail itself never fails the caller.
	if pending != nil {
		enqueueEmail(ctx, r.mailer, db.New(r.pool), pending.visit, pending.tpl, locationID, vendorUserID, pending.audiences...)
	}
	return nil
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
	var pending *pendingEmail
	var locationID, vendorUserID uuid.UUID
	if err := WithTx(ctx, r.pool, func(tx pgx.Tx) error {
		q := db.New(r.pool).WithTx(tx)
		locked, err := q.GetVisitByIDForUpdate(ctx, db.GetVisitByIDForUpdateParams{ID: parsed})
		if err != nil {
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
		locationID, vendorUserID = locked.LocationID, locked.VendorUserID
		staffTpl := domain.TransitionNotification(domain.VisitStatusRescheduled, false, locked.VisitID)
		if err := emit(ctx, q, staffTpl, locked.ID, locked.LocationID, locked.VendorUserID, time.Now()); err != nil {
			return err
		}
		// Every reschedule also notifies the vendor with the same
		// visit_rescheduled type. The staff row above and this vendor row
		// address disjoint recipient sets, and a repeat reschedule collapses
		// on the store's unique constraint, so the dual emit is idempotent
		// without actor branching.
		vendorTpl := domain.RescheduledVendorNotification(locked.VisitID)
		if err := emit(ctx, q, vendorTpl, locked.ID, locked.LocationID, locked.VendorUserID, time.Now()); err != nil {
			return err
		}
		// The dual in_app emit collapses to ONE email over the union of both
		// audiences: the two templates carry the same type and copy, so one
		// BuildEmail renders both.
		pending = &pendingEmail{
			visit:     emailVisit(locked, start, end, reason),
			tpl:       staffTpl,
			audiences: []domain.NotificationAudience{staffTpl.Audience, vendorTpl.Audience},
		}
		if err := attachMembers(ctx, q, parsed, pending); err != nil {
			return err
		}
		return nil
	}); err != nil {
		return err
	}
	if pending != nil {
		enqueueEmail(ctx, r.mailer, db.New(r.pool), pending.visit, pending.tpl, locationID, vendorUserID, pending.audiences...)
	}
	return nil
}

// emailVisit projects the locked row onto the BuildEmail context: the visit
// code, the location, the schedule the notice is about, and the actor's note
// as the reason row (omitted when blank).
func emailVisit(locked db.GetVisitByIDForUpdateRow, start, end time.Time, note string) domain.VisitRequest {
	visit := domain.VisitRequest{
		VisitID:      locked.VisitID,
		LocationName: locked.LocationName,
		StartDate:    start,
		EndDate:      end,
	}
	if strings.TrimSpace(note) != "" {
		visit.StatusNote = notePtr(note)
	}
	return visit
}

// notePtr maps an empty note to NULL so history rows carry a note only when
// the actor actually wrote one.
func notePtr(note string) *string {
	if note == "" {
		return nil
	}
	return &note
}
