package repository

import (
	"context"

	"github.com/google/uuid"
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
// hard `location_id = $1` query, a vendor scope only the `pic_user_id = $1`
// query, and the unscoped super_admin query runs ONLY when both are nil, so
// there is no code path where a branch caller silently receives every branch.
// When both scopes are set the branch scope wins and the vendor scope is ignored;
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
		visits := locationRowsToDomain(rows)
		if err := r.attachPageVisitors(ctx, visits); err != nil {
			return nil, 0, err
		}
		return visits, total, nil
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
		visits := vendorRowsToDomain(rows)
		if err := r.attachPageVisitors(ctx, visits); err != nil {
			return nil, 0, err
		}
		return visits, total, nil
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
	visits := superAdminRowsToDomain(rows)
	if err := r.attachPageVisitors(ctx, visits); err != nil {
		return nil, 0, err
	}
	return visits, total, nil
}

// attachPageVisitors loads every roster AND every purpose catalogue of one
// page with two single IN (...) queries (the sqlc.yaml batch design) and
// attaches each to its visit. An empty page issues no query; every returned
// visit carries non-nil slices so the wire renders [] instead of null.
func (r *visitRepository) attachPageVisitors(ctx context.Context, visits []domain.VisitRequest) error {
	ids := make([]uuid.UUID, 0, len(visits))
	for _, visit := range visits {
		parsed, err := fromDomainUUID(visit.ID)
		if err != nil {
			return err
		}
		ids = append(ids, parsed)
	}
	for i := range visits {
		visits[i].Visitors = []domain.Visitor{}
		visits[i].Purposes = []domain.Purpose{}
	}
	if len(ids) == 0 {
		return nil
	}
	q := db.New(r.pool)
	rows, err := q.ListVisitors(ctx, db.ListVisitorsParams{VisitRequestIds: ids})
	if err != nil {
		return MapError(err)
	}
	grouped := groupVisitorsByVisit(rows)
	purposeRows, err := q.ListVisitPurposes(ctx, db.ListVisitPurposesParams{VisitRequestIds: ids})
	if err != nil {
		return MapError(err)
	}
	groupedPurposes := groupPurposesByVisit(purposeRows)
	for i := range visits {
		parsed, err := fromDomainUUID(visits[i].ID)
		if err != nil {
			return err
		}
		if roster, ok := grouped[parsed]; ok {
			visits[i].Visitors = roster
		}
		if purposes, ok := groupedPurposes[parsed]; ok {
			visits[i].Purposes = purposes
		}
	}
	return nil
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
