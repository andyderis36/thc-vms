package repository

import (
	"context"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/repository/db"
)

// Compile-time proof that the visit adapter also satisfies the read-only
// suggestion port.
var _ domain.SuggestionRepository = (*visitRepository)(nil)

// ListVendorSuggestions returns the raw vendor-name sources for
// GET /vendors/suggestions. The SQL already applies the branch/global filter
// and the optional prefix filter; dedupe and source priority live in the
// usecase so they stay unit-testable without a database. Rows are always
// non-nil so the wire renders `"data": []` instead of null.
func (r *visitRepository) ListVendorSuggestions(ctx context.Context, filter domain.VendorSuggestionFilter) ([]domain.VendorSuggestion, error) {
	ids, err := toRepoUUIDs(filter.LocationIDs)
	if err != nil {
		return nil, err
	}
	rows, err := db.New(r.pool).ListVendorSuggestionSources(ctx, db.ListVendorSuggestionSourcesParams{
		IsGlobal:    filter.IsGlobal,
		LocationIds: ids,
		Q:           searchParam(filter.Query),
	})
	if err != nil {
		return nil, MapError(err)
	}
	out := make([]domain.VendorSuggestion, 0, len(rows))
	for _, row := range rows {
		out = append(out, domain.VendorSuggestion{
			Name:   row.Name,
			Source: domain.VendorSuggestionSource(row.Source),
		})
	}
	return out, nil
}

// ListMemberSuggestions returns the scoped member reuse candidates. The
// dispatch is total: a vendor filter can only reach the ownership query, and a
// branch/global filter only the union query, so no parameter can cross the two
// scopes. Both variants already dedupe by (name, phone) on the newest visit
// and cap the page at 20.
func (r *visitRepository) ListMemberSuggestions(ctx context.Context, filter domain.MemberSuggestionFilter) ([]domain.MemberSuggestion, error) {
	q := db.New(r.pool)
	if filter.VendorUserID != nil {
		vendorUserID, err := fromDomainUUID(*filter.VendorUserID)
		if err != nil {
			return nil, err
		}
		rows, err := q.ListMemberSuggestionsForVendor(ctx, db.ListMemberSuggestionsForVendorParams{
			VendorUserID: vendorUserID,
			Q:            searchParam(filter.Query),
		})
		if err != nil {
			return nil, MapError(err)
		}
		return vendorMemberSuggestionRowsToDomain(rows), nil
	}
	ids, err := toRepoUUIDs(filter.LocationIDs)
	if err != nil {
		return nil, err
	}
	rows, err := q.ListMemberSuggestionsForScope(ctx, db.ListMemberSuggestionsForScopeParams{
		IsGlobal:    filter.IsGlobal,
		LocationIds: ids,
		VendorName:  searchParam(filter.VendorName),
		Q:           searchParam(filter.Query),
	})
	if err != nil {
		return nil, MapError(err)
	}
	return scopeMemberSuggestionRowsToDomain(rows), nil
}

// FindVisitorByID resolves one roster member for the single-member pick
// endpoint. The caller applies the visit read scope BEFORE exposing the row;
// an unknown id surfaces domain.ErrNotFound through MapError.
func (r *visitRepository) FindVisitorByID(ctx context.Context, id domain.UUID) (domain.Visitor, error) {
	parsed, err := fromDomainUUID(id)
	if err != nil {
		return domain.Visitor{}, err
	}
	row, err := db.New(r.pool).GetVisitorByID(ctx, db.GetVisitorByIDParams{ID: parsed})
	if err != nil {
		return domain.Visitor{}, MapError(err)
	}
	return domain.Visitor{
		ID:                 mustDomainUUID(row.ID),
		VisitRequestID:     mustDomainUUID(row.VisitRequestID),
		Name:               row.Name,
		IDNumber:           row.IDNumber,
		Phone:              row.Phone,
		IDCardPhotoURL:     textPtr(row.IDCardPhotoUrl),
		PhotoURL:           textPtr(row.PhotoUrl),
		VendorID:           nullUUIDToDomain(row.VendorID),
		VendorName:         resolveVendorDisplayName(row.VendorNameOverride, row.VendorName),
		VendorNameOverride: textPtr(row.VendorNameOverride),
		Jabatan:            textPtr(row.Jabatan),
		Email:              textPtr(row.Email),
		PhoneEdited:        row.PhoneEdited,
		CreatedAt:          row.CreatedAt,
	}, nil
}

// scopeMemberSuggestionRowsToDomain projects the branch/global member page.
func scopeMemberSuggestionRowsToDomain(rows []db.ListMemberSuggestionsForScopeRow) []domain.MemberSuggestion {
	out := make([]domain.MemberSuggestion, 0, len(rows))
	for _, row := range rows {
		out = append(out, domain.MemberSuggestion{
			Name:          row.Name,
			IDNumber:      row.IDNumber,
			Phone:         row.Phone,
			Email:         textPtr(row.Email),
			Jabatan:       textPtr(row.Jabatan),
			LastVisitAt:   row.LastVisitAt,
			VisitorID:     mustDomainUUID(row.VisitorID),
			SourceVisitID: mustDomainUUID(row.SourceVisitID),
		})
	}
	return out
}

// vendorMemberSuggestionRowsToDomain projects the actor-owned member page.
func vendorMemberSuggestionRowsToDomain(rows []db.ListMemberSuggestionsForVendorRow) []domain.MemberSuggestion {
	out := make([]domain.MemberSuggestion, 0, len(rows))
	for _, row := range rows {
		out = append(out, domain.MemberSuggestion{
			Name:          row.Name,
			IDNumber:      row.IDNumber,
			Phone:         row.Phone,
			Email:         textPtr(row.Email),
			Jabatan:       textPtr(row.Jabatan),
			LastVisitAt:   row.LastVisitAt,
			VisitorID:     mustDomainUUID(row.VisitorID),
			SourceVisitID: mustDomainUUID(row.SourceVisitID),
		})
	}
	return out
}
