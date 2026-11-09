package repository

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/repository/db"
)

// checkInOutRepository is the PostgreSQL adapter for
// domain.CheckInOutRepository. The schema keeps one check-in and one
// check-out per visit (UNIQUE on visit_request_id with deliberately no ON
// CONFLICT clause), so a second record for the same visit surfaces
// domain.ErrConflict through MapError's 23505 mapping.
type checkInOutRepository struct {
	pool *pgxpool.Pool
}

// Compile-time proof that the adapter satisfies its port.
var _ domain.CheckInOutRepository = (*checkInOutRepository)(nil)

// NewCheckInOutRepository builds the PostgreSQL-backed domain.CheckInOutRepository.
func NewCheckInOutRepository(pool *pgxpool.Pool) domain.CheckInOutRepository {
	return &checkInOutRepository{pool: pool}
}

// RecordCheckIn persists the gate entry record. A zero CheckedInAt means
// "now" on the application clock; the caller owns the tolerance-window check.
func (r *checkInOutRepository) RecordCheckIn(ctx context.Context, checkIn domain.CheckIn) (domain.CheckIn, error) {
	visitID, err := fromDomainUUID(checkIn.VisitRequestID)
	if err != nil {
		return domain.CheckIn{}, err
	}
	staffID, err := fromDomainUUID(checkIn.CheckedInBy)
	if err != nil {
		return domain.CheckIn{}, err
	}
	row, err := db.New(r.pool).InsertCheckIn(ctx, db.InsertCheckInParams{
		VisitRequestID: visitID,
		CheckedInAt:    coalesceTime(checkIn.CheckedInAt),
		CheckedInBy:    staffID,
		PhotoUrl:       pgText(checkIn.PhotoURL),
		BadgeCode:      pgText(checkIn.BadgeCode),
	})
	if err != nil {
		return domain.CheckIn{}, MapError(err)
	}
	return domain.CheckIn{
		ID:             mustDomainUUID(row.ID),
		VisitRequestID: mustDomainUUID(row.VisitRequestID),
		CheckedInAt:    row.CheckedInAt,
		CheckedInBy:    mustDomainUUID(row.CheckedInBy),
		PhotoURL:       textPtr(row.PhotoUrl),
		BadgeCode:      textPtr(row.BadgeCode),
	}, nil
}

// RecordCheckOut persists the gate exit record.
func (r *checkInOutRepository) RecordCheckOut(ctx context.Context, checkOut domain.CheckOut) (domain.CheckOut, error) {
	visitID, err := fromDomainUUID(checkOut.VisitRequestID)
	if err != nil {
		return domain.CheckOut{}, err
	}
	staffID, err := fromDomainUUID(checkOut.CheckedOutBy)
	if err != nil {
		return domain.CheckOut{}, err
	}
	row, err := db.New(r.pool).InsertCheckOut(ctx, db.InsertCheckOutParams{
		VisitRequestID: visitID,
		CheckedOutAt:   coalesceTime(checkOut.CheckedOutAt),
		CheckedOutBy:   staffID,
	})
	if err != nil {
		return domain.CheckOut{}, MapError(err)
	}
	return domain.CheckOut{
		ID:             mustDomainUUID(row.ID),
		VisitRequestID: mustDomainUUID(row.VisitRequestID),
		CheckedOutAt:   row.CheckedOutAt,
		CheckedOutBy:   mustDomainUUID(row.CheckedOutBy),
	}, nil
}

// FindCheckInByVisit resolves the entry record; a visit with no check-in yet
// reports domain.ErrNotFound, which is also the existence check the no-show
// worker relies on.
func (r *checkInOutRepository) FindCheckInByVisit(ctx context.Context, visitID domain.UUID) (domain.CheckIn, error) {
	parsed, err := fromDomainUUID(visitID)
	if err != nil {
		return domain.CheckIn{}, err
	}
	row, err := db.New(r.pool).GetCheckInByVisitRequest(ctx, db.GetCheckInByVisitRequestParams{VisitRequestID: parsed})
	if err != nil {
		return domain.CheckIn{}, MapError(err)
	}
	return domain.CheckIn{
		ID:              mustDomainUUID(row.ID),
		VisitRequestID:  mustDomainUUID(row.VisitRequestID),
		CheckedInAt:     row.CheckedInAt,
		CheckedInBy:     mustDomainUUID(row.CheckedInBy),
		CheckedInByName: textPtr(row.CheckedInByName),
		PhotoURL:        textPtr(row.PhotoUrl),
		BadgeCode:       textPtr(row.BadgeCode),
	}, nil
}

// FindCheckOutByVisit resolves the exit record; missing means not checked out.
func (r *checkInOutRepository) FindCheckOutByVisit(ctx context.Context, visitID domain.UUID) (domain.CheckOut, error) {
	parsed, err := fromDomainUUID(visitID)
	if err != nil {
		return domain.CheckOut{}, err
	}
	row, err := db.New(r.pool).GetCheckOutByVisitRequest(ctx, db.GetCheckOutByVisitRequestParams{VisitRequestID: parsed})
	if err != nil {
		return domain.CheckOut{}, MapError(err)
	}
	return domain.CheckOut{
		ID:              mustDomainUUID(row.ID),
		VisitRequestID:  mustDomainUUID(row.VisitRequestID),
		CheckedOutAt:    row.CheckedOutAt,
		CheckedOutBy:    mustDomainUUID(row.CheckedOutBy),
		CheckedOutByName: textPtr(row.CheckedOutByName),
	}, nil
}

// coalesceTime defaults an unset gate instant to the current time so a caller
// that only knows "now" never writes the zero timestamp.
func coalesceTime(t time.Time) time.Time {
	if t.IsZero() {
		return time.Now().UTC()
	}
	return t
}
