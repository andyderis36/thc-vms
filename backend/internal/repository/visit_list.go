package repository

import (
	"context"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/repository/db"
)

// defaultListLimit is the page size when the caller passes no limit.
const defaultListLimit = 10

// maxListLimit caps a single page so a caller cannot ask for the whole table.
const maxListLimit = 100

// List returns one page plus the total for the caller's scope. The dispatch is
// total and branch-safe by construction: a location scope can only reach the
// hard `location_id = $1` query, a vendor scope only the `vendor_user_id = $1`
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
			Search:     searchParam(filter.Search),
			SortBy:     sortParam(string(filter.SortBy.Normalized())),
			SortOrder:  sortParam(string(filter.Order.Normalized())),
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
			Search:     searchParam(filter.Search),
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

	if filter.VendorUserID != nil {
		vendorUserID, err := fromDomainUUID(*filter.VendorUserID)
		if err != nil {
			return nil, 0, err
		}
		rows, err := q.ListVisitsForVendorUser(ctx, db.ListVisitsForVendorUserParams{
			VendorUserID: vendorUserID,
			Status:       statusParam(filter.Status),
			DateFrom:     pgTimestamptz(filter.From),
			DateTo:       pgTimestamptz(filter.To),
			Search:       searchParam(filter.Search),
			SortBy:       sortParam(string(filter.SortBy.Normalized())),
			SortOrder:    sortParam(string(filter.Order.Normalized())),
			Offset:       offset,
			Limit:        limit32,
		})
		if err != nil {
			return nil, 0, MapError(err)
		}
		total, err := q.CountVisitsForVendorUser(ctx, db.CountVisitsForVendorUserParams{
			VendorUserID: vendorUserID,
			Status:       statusParam(filter.Status),
			DateFrom:     pgTimestamptz(filter.From),
			DateTo:       pgTimestamptz(filter.To),
			Search:       searchParam(filter.Search),
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
		Search:     searchParam(filter.Search),
		SortBy:     sortParam(string(filter.SortBy.Normalized())),
		SortOrder:  sortParam(string(filter.Order.Normalized())),
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
		Search:     searchParam(filter.Search),
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

// sortParam maps one ORDER BY knob to its nullable SQL predicate: blank means
// SQL NULL so the query's COALESCE falls back to the legacy default
// (created_at desc); a trimmed value travels as a bound parameter compared
// inside static CASE branches, never concatenated into SQL.
func sortParam(sort string) pgtype.Text {
	if strings.TrimSpace(sort) == "" {
		return pgtype.Text{}
	}
	return pgtype.Text{String: strings.TrimSpace(sort), Valid: true}
}

// searchParam maps the free-text filter to the nullable search predicate the
// list/count queries share: blank means SQL NULL (no text match, legacy
// unfiltered listing), a trimmed term means ILIKE over vendor user name / visit_id.
func searchParam(search string) pgtype.Text {
	if strings.TrimSpace(search) == "" {
		return pgtype.Text{}
	}
	return pgtype.Text{String: strings.TrimSpace(search), Valid: true}
}
