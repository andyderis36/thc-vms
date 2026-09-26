package repository

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/repository/db"
)

// defaultListLimit is the page size when the caller passes no limit.
const defaultListLimit = 20

// maxListLimit caps a single page so a caller cannot ask for the whole table.
const maxListLimit = 100

// List returns one page plus the total for the caller's scope. The dispatch is
// total and branch-safe by construction: a location scope can only reach the
// hard `location_id = $1` query, a PIC scope only the `pic_user_id = $1`
// query, and the unscoped super_admin query runs ONLY when both are nil, so
// there is no code path where a branch caller silently receives every branch.
// When both scopes are set the branch scope wins and the PIC scope is ignored;
// the generated queries offer no combined predicate, and branch isolation is
// the invariant that must never be widened.
func (r *visitRepository) List(
	ctx context.Context,
	filter domain.VisitFilter,
) ([]domain.VisitRequest, int64, error) {
	page, limit := normalizePage(filter.Page, filter.Limit)
	offset := int32((page - 1) * limit) //nolint:gosec // page/limit are clamped above
	limit32 := int32(limit)             //nolint:gosec // limit is clamped to maxListLimit
	q := db.New(r.pool)

	if filter.LocationID != nil {
		locationID, err := fromDomainUUID(*filter.LocationID)
		if err != nil {
			return nil, 0, err
		}
		rows, err := q.ListVisitsForLocation(ctx, db.ListVisitsForLocationParams{
			LocationID: locationID,
			Status:     statusParam(filter.Status),
			DateFrom:   pgTimestamptz(filter.From),
			DateTo:     pgTimestamptz(filter.To),
			Search:     pgtype.Text{},
			Offset:     offset,
			Limit:      limit32,
		})
		if err != nil {
			return nil, 0, MapError(err)
		}
		total, err := q.CountVisitsForLocation(ctx, db.CountVisitsForLocationParams{
			LocationID: locationID,
			Status:     statusParam(filter.Status),
			DateFrom:   pgTimestamptz(filter.From),
			DateTo:     pgTimestamptz(filter.To),
			Search:     pgtype.Text{},
		})
		if err != nil {
			return nil, 0, MapError(err)
		}
		return locationRowsToDomain(rows), total, nil
	}

	if filter.PICUserID != nil {
		picID, err := fromDomainUUID(*filter.PICUserID)
		if err != nil {
			return nil, 0, err
		}
		rows, err := q.ListVisitsForPIC(ctx, db.ListVisitsForPICParams{
			PicUserID: picID,
			Status:    statusParam(filter.Status),
			DateFrom:  pgTimestamptz(filter.From),
			DateTo:    pgTimestamptz(filter.To),
			Search:    pgtype.Text{},
			Offset:    offset,
			Limit:     limit32,
		})
		if err != nil {
			return nil, 0, MapError(err)
		}
		total, err := q.CountVisitsForPIC(ctx, db.CountVisitsForPICParams{
			PicUserID: picID,
			Status:    statusParam(filter.Status),
			DateFrom:  pgTimestamptz(filter.From),
			DateTo:    pgTimestamptz(filter.To),
			Search:    pgtype.Text{},
		})
		if err != nil {
			return nil, 0, MapError(err)
		}
		return picRowsToDomain(rows), total, nil
	}

	rows, err := q.ListVisitsForSuperAdmin(ctx, db.ListVisitsForSuperAdminParams{
		LocationID: pgtype.UUID{},
		Status:     statusParam(filter.Status),
		DateFrom:   pgTimestamptz(filter.From),
		DateTo:     pgTimestamptz(filter.To),
		Search:     pgtype.Text{},
		Offset:     offset,
		Limit:      limit32,
	})
	if err != nil {
		return nil, 0, MapError(err)
	}
	total, err := q.CountVisitsForSuperAdmin(ctx, db.CountVisitsForSuperAdminParams{
		LocationID: pgtype.UUID{},
		Status:     statusParam(filter.Status),
		DateFrom:   pgTimestamptz(filter.From),
		DateTo:     pgTimestamptz(filter.To),
		Search:     pgtype.Text{},
	})
	if err != nil {
		return nil, 0, MapError(err)
	}
	return superAdminRowsToDomain(rows), total, nil
}

// normalizePage clamps 1-based pagination to sane bounds.
func normalizePage(page, limit int) (int, int) {
	if page < 1 {
		page = 1
	}
	if limit <= 0 {
		limit = defaultListLimit
	}
	if limit > maxListLimit {
		limit = maxListLimit
	}
	return page, limit
}

// statusParam maps the optional status filter to a nullable text predicate:
// nil means "any status", never a widened branch scope.
func statusParam(status *domain.VisitStatus) pgtype.Text {
	if status == nil {
		return pgtype.Text{}
	}
	return pgtype.Text{String: string(*status), Valid: true}
}
