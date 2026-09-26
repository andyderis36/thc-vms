package repository

import (
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/repository/db"
)

// visitRowToDomain projects a bare visit_request row onto the domain request.
func visitRowToDomain(row db.VisitRequest) (domain.VisitRequest, error) {
	status, err := domain.ParseVisitStatus(row.Status)
	if err != nil {
		return domain.VisitRequest{}, err
	}
	return domain.VisitRequest{
		ID:                  mustDomainUUID(row.ID),
		VisitID:             row.VisitID,
		PICUserID:           mustDomainUUID(row.PicUserID),
		VendorID:            nullUUIDToDomain(row.VendorID),
		LocationID:          mustDomainUUID(row.LocationID),
		StartDate:           row.StartDate,
		EndDate:             row.EndDate,
		IsMultiDay:          row.IsMultiDay,
		Status:              status,
		AssignmentLetterURL: textPtr(row.AssignmentLetterUrl),
		IsNDAAccepted:       row.IsNdaAccepted,
		Notes:               textPtr(row.Notes),
		CreatedAt:           row.CreatedAt,
		UpdatedAt:           row.UpdatedAt,
	}, nil
}

// detailRowToDomain projects the GET /visits/{id} join onto the domain request.
// The joined display names serve the openapi VisitDetail schema and are not
// part of the domain entity, so they are deliberately dropped here.
func detailRowToDomain(row db.GetVisitByIDRow) (domain.VisitRequest, error) {
	return visitFieldsToDomain(
		row.ID, row.VisitID, row.PicUserID, row.VendorID, row.LocationID,
		row.StartDate, row.EndDate, row.IsMultiDay, row.Status,
		row.AssignmentLetterUrl, row.IsNdaAccepted, row.Notes,
		row.CreatedAt, row.UpdatedAt,
	)
}

// visitCodeRowToDomain projects the scanner lookup row the same way.
func visitCodeRowToDomain(row db.GetVisitByVisitCodeRow) (domain.VisitRequest, error) {
	return visitFieldsToDomain(
		row.ID, row.VisitID, row.PicUserID, row.VendorID, row.LocationID,
		row.StartDate, row.EndDate, row.IsMultiDay, row.Status,
		row.AssignmentLetterUrl, row.IsNdaAccepted, row.Notes,
		row.CreatedAt, row.UpdatedAt,
	)
}

// visitFieldsToDomain is the single mapping every visit read funnels through
// so the five list/detail projections cannot drift from each other.
func visitFieldsToDomain(
	id uuid.UUID,
	visitID string,
	picUserID uuid.UUID,
	vendorID pgtype.UUID,
	locationID uuid.UUID,
	startDate time.Time,
	endDate time.Time,
	isMultiDay bool,
	status string,
	assignmentLetterURL pgtype.Text,
	isNDAAccepted bool,
	notes pgtype.Text,
	createdAt time.Time,
	updatedAt time.Time,
) (domain.VisitRequest, error) {
	parsed, err := domain.ParseVisitStatus(status)
	if err != nil {
		return domain.VisitRequest{}, err
	}
	return domain.VisitRequest{
		ID:                  mustDomainUUID(id),
		VisitID:             visitID,
		PICUserID:           mustDomainUUID(picUserID),
		VendorID:            nullUUIDToDomain(vendorID),
		LocationID:          mustDomainUUID(locationID),
		StartDate:           startDate,
		EndDate:             endDate,
		IsMultiDay:          isMultiDay,
		Status:              parsed,
		AssignmentLetterURL: textPtr(assignmentLetterURL),
		IsNDAAccepted:       isNDAAccepted,
		Notes:               textPtr(notes),
		CreatedAt:           createdAt,
		UpdatedAt:           updatedAt,
	}, nil
}

// nullUUIDToDomain renders a nullable uuid column as a domain identifier:
// NULL becomes the empty UUID, never the zero-UUID text.
func nullUUIDToDomain(id pgtype.UUID) domain.UUID {
	if !id.Valid {
		return ""
	}
	return toDomainUUID(id.Bytes)
}

// locationRowsToDomain projects the branch-scoped page.
func locationRowsToDomain(rows []db.ListVisitsForLocationRow) []domain.VisitRequest {
	out := make([]domain.VisitRequest, 0, len(rows))
	for _, row := range rows {
		visit, err := visitFieldsToDomain(
			row.ID, row.VisitID, row.PicUserID, row.VendorID, row.LocationID,
			row.StartDate, row.EndDate, row.IsMultiDay, row.Status,
			row.AssignmentLetterUrl, row.IsNdaAccepted, row.Notes,
			row.CreatedAt, row.UpdatedAt,
		)
		if err != nil {
			continue
		}
		out = append(out, visit)
	}
	return out
}

// picRowsToDomain projects the vendor-scoped page.
func picRowsToDomain(rows []db.ListVisitsForPICRow) []domain.VisitRequest {
	out := make([]domain.VisitRequest, 0, len(rows))
	for _, row := range rows {
		visit, err := visitFieldsToDomain(
			row.ID, row.VisitID, row.PicUserID, row.VendorID, row.LocationID,
			row.StartDate, row.EndDate, row.IsMultiDay, row.Status,
			row.AssignmentLetterUrl, row.IsNdaAccepted, row.Notes,
			row.CreatedAt, row.UpdatedAt,
		)
		if err != nil {
			continue
		}
		out = append(out, visit)
	}
	return out
}

// superAdminRowsToDomain projects the unscoped page.
func superAdminRowsToDomain(rows []db.ListVisitsForSuperAdminRow) []domain.VisitRequest {
	out := make([]domain.VisitRequest, 0, len(rows))
	for _, row := range rows {
		visit, err := visitFieldsToDomain(
			row.ID, row.VisitID, row.PicUserID, row.VendorID, row.LocationID,
			row.StartDate, row.EndDate, row.IsMultiDay, row.Status,
			row.AssignmentLetterUrl, row.IsNdaAccepted, row.Notes,
			row.CreatedAt, row.UpdatedAt,
		)
		if err != nil {
			continue
		}
		out = append(out, visit)
	}
	return out
}
