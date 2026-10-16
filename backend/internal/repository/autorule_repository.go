package repository

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/repository/db"
)

// visitAutoRuleRepository is the PostgreSQL adapter for
// domain.VisitAutoRuleRepository: the read side of the background worker.
//
// The three sweep queries take NO time parameter — each hard-codes its PRD
// threshold against now() (7 days, end_date + 2h, end_date + 24h) and locks
// the matched rows. The before instant the port receives is therefore applied
// as a second, in-Go comparison on the hydrated visit, so a caller can narrow
// the sweep to an older horizon without inventing a query parameter the SQL
// does not support. With before == now the Go comparison is a no-op and the
// result is exactly the SQL sweep.
//
// Sweep rows carry only the rule's ordering key; the full visit (vendor,
// NDA flag, notes, audit timestamps) is hydrated with ONE batched
// GetVisitsByIDs read plus the two batched roster/purpose attaches, so the
// worker receives complete domain.VisitRequest values and can re-assert the
// match before transitioning through VisitRepository.UpdateStatus.
type visitAutoRuleRepository struct {
	pool   *pgxpool.Pool
	visits *visitRepository
	// batchLoad loads full visits for swept ids. Production wires the
	// single-round-trip batch below; tests substitute a counting fake to
	// prove hydrate() fans out to exactly one load, never N FindByID calls.
	batchLoad func(ctx context.Context, ids []uuid.UUID) ([]domain.VisitRequest, error)
}

// Compile-time proof that the adapter satisfies its port.
var _ domain.VisitAutoRuleRepository = (*visitAutoRuleRepository)(nil)

// NewVisitAutoRuleRepository builds the PostgreSQL-backed
// domain.VisitAutoRuleRepository.
func NewVisitAutoRuleRepository(pool *pgxpool.Pool) domain.VisitAutoRuleRepository {
	r := &visitAutoRuleRepository{pool: pool, visits: &visitRepository{pool: pool}}
	r.batchLoad = r.loadVisitsBatch
	return r
}

// FindStaleRequested returns requested visits older than before (R1: the SQL
// pre-filters to created_at < now() - 7 days; the Go comparison keeps rows
// with created_at strictly before the caller's horizon).
func (r *visitAutoRuleRepository) FindStaleRequested(
	ctx context.Context,
	before time.Time,
) ([]domain.VisitRequest, error) {
	rows, err := db.New(r.pool).SweepStaleRequestedVisits(ctx)
	if err != nil {
		return nil, MapError(err)
	}
	ids := make([]uuid.UUID, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	return r.hydrate(ctx, ids, domain.VisitStatusRequested, func(visit domain.VisitRequest) bool {
		return visit.CreatedAt.Before(before)
	})
}

// FindNoShowApproved returns approved visits whose window closed before the
// horizon with no check-in (R2: the SQL pre-filters to end_date < now() - 2h
// plus the check_in anti-join; the Go comparison keeps rows with
// end_date + 2h at or before the caller's horizon).
func (r *visitAutoRuleRepository) FindNoShowApproved(
	ctx context.Context,
	before time.Time,
) ([]domain.VisitRequest, error) {
	rows, err := db.New(r.pool).SweepNoShowApprovedVisits(ctx)
	if err != nil {
		return nil, MapError(err)
	}
	ids := make([]uuid.UUID, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	return r.hydrate(ctx, ids, domain.VisitStatusApproved, func(visit domain.VisitRequest) bool {
		return !visit.EndDate.Add(2 * time.Hour).After(before)
	})
}

// FindOverstayedVisiting returns visiting visits past their grace period (R3:
// the SQL pre-filters to end_date < now() - 24h; the Go comparison keeps rows
// with end_date + 24h at or before the caller's horizon).
func (r *visitAutoRuleRepository) FindOverstayedVisiting(
	ctx context.Context,
	before time.Time,
) ([]domain.VisitRequest, error) {
	rows, err := db.New(r.pool).SweepStaleVisitingVisits(ctx)
	if err != nil {
		return nil, MapError(err)
	}
	ids := make([]uuid.UUID, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	return r.hydrate(ctx, ids, domain.VisitStatusVisiting, func(visit domain.VisitRequest) bool {
		return !visit.EndDate.Add(24 * time.Hour).After(before)
	})
}

// loadVisitsBatch loads a whole capped sweep in THREE round trips total: one
// GetVisitsByIDs detail read plus the two batched IN (...) attaches (roster
// and purposes) mirroring attachPageVisitors in visit_list.go — never N
// FindByID reads.
func (r *visitAutoRuleRepository) loadVisitsBatch(
	ctx context.Context,
	ids []uuid.UUID,
) ([]domain.VisitRequest, error) {
	if len(ids) == 0 {
		return []domain.VisitRequest{}, nil
	}
	rows, err := db.New(r.pool).GetVisitsByIDs(ctx, db.GetVisitsByIDsParams{VisitIds: ids})
	if err != nil {
		return nil, MapError(err)
	}
	visits := make([]domain.VisitRequest, 0, len(rows))
	for _, row := range rows {
		visit, err := batchVisitRowToDomain(row)
		if err != nil {
			return nil, err
		}
		visits = append(visits, visit)
	}
	if err := r.visits.attachPageVisitors(ctx, visits); err != nil {
		return nil, err
	}
	return visits, nil
}

// batchVisitRowToDomain projects one GetVisitsByIDs row exactly like the
// single-row detail read, so the batched hydrate cannot drift from GET
// /visits/{id}.
func batchVisitRowToDomain(row db.GetVisitsByIDsRow) (domain.VisitRequest, error) {
	return visitFieldsToDomain(
		row.ID, row.VisitID, row.PicUserID, row.VendorID, row.LocationID,
		row.StartDate, row.EndDate, row.IsMultiDay, row.Status,
		row.AssignmentLetterUrl, row.IsNdaAccepted, row.Notes,
		row.PurposeNote,
		row.CreatedAt, row.UpdatedAt, row.VendorName,
		row.LocationName, row.LocationType,
		row.PicName, row.PicEmail,
	)
}

// hydrate loads the swept ids with ONE batch load and keeps the visits that
// still hold the rule's source status and satisfy the caller's horizon.
// Sweep order is preserved so R1/R2/R3 keep their oldest-first migration
// order. Re-checking the status matters because the sweep lock is released
// when its statement ends: a visit approved or checked in between the sweep
// and this read must not be reported under its stale status. An id missing
// from the batch (raced delete) is skipped: the row is gone, so there is
// nothing to transition.
func (r *visitAutoRuleRepository) hydrate(
	ctx context.Context,
	ids []uuid.UUID,
	status domain.VisitStatus,
	keep func(domain.VisitRequest) bool,
) ([]domain.VisitRequest, error) {
	out := make([]domain.VisitRequest, 0, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	visits, err := r.batchLoad(ctx, ids)
	if err != nil {
		return nil, err
	}
	byID := make(map[uuid.UUID]domain.VisitRequest, len(visits))
	for _, visit := range visits {
		parsed, err := fromDomainUUID(visit.ID)
		if err != nil {
			return nil, err
		}
		byID[parsed] = visit
	}
	for _, id := range ids {
		visit, ok := byID[id]
		if !ok {
			continue
		}
		if visit.Status != status || !keep(visit) {
			continue
		}
		out = append(out, visit)
	}
	return out, nil
}
