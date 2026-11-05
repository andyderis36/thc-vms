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
		VendorUserID:        mustDomainUUID(row.VendorUserID),
		VendorID:            nullUUIDToDomain(row.VendorID),
		LocationID:          mustDomainUUID(row.LocationID),
		StartDate:           row.StartDate,
		EndDate:             row.EndDate,
		IsMultiDay:          row.IsMultiDay,
		Status:              status,
		AssignmentLetterURL: textPtr(row.AssignmentLetterUrl),
		IsNDAAccepted:       row.IsNdaAccepted,
		Notes:               textPtr(row.Notes),
		PurposeNote:         textPtr(row.PurposeNote),
		CreatedAt:           row.CreatedAt,
		UpdatedAt:           row.UpdatedAt,
		VendorNameOverride:  textPtr(row.VendorNameOverride),
	}, nil
}

// detailRowToDomain projects the GET /visits/{id} join onto the domain request.
// The vendor display name rides along for the openapi VisitDetail vendor_name
// member; location name/type ride along for the location member (kolom
// Fasilitas FE); vendor name/email ride along for the vendor_user member (kartu
// Informasi Kunjungan FE). The vendor profile beyond name/email stays id-only
// and belongs to user endpoints.
func detailRowToDomain(row db.GetVisitByIDRow) (domain.VisitRequest, error) {
	return visitFieldsToDomain(
		row.ID, row.VisitID, row.VendorUserID, row.VendorID, row.LocationID,
		row.StartDate, row.EndDate, row.IsMultiDay, row.Status,
		row.AssignmentLetterUrl, row.IsNdaAccepted, row.Notes,
		row.PurposeNote, row.VendorNameOverride,
		row.CreatedAt, row.UpdatedAt, row.VendorName,
		row.LocationName, row.LocationType,
		row.VendorUserName, row.VendorUserEmail, row.VendorUserVendorName,
	)
}

// visitCodeRowToDomain projects the scanner lookup row the same way.
func visitCodeRowToDomain(row db.GetVisitByVisitCodeRow) (domain.VisitRequest, error) {
	return visitFieldsToDomain(
		row.ID, row.VisitID, row.VendorUserID, row.VendorID, row.LocationID,
		row.StartDate, row.EndDate, row.IsMultiDay, row.Status,
		row.AssignmentLetterUrl, row.IsNdaAccepted, row.Notes,
		row.PurposeNote, row.VendorNameOverride,
		row.CreatedAt, row.UpdatedAt, row.VendorName,
		row.LocationName, row.LocationType,
		row.VendorUserName, row.VendorUserEmail, row.VendorUserVendorName,
	)
}

// visitFieldsToDomain is the single mapping every visit read funnels through
// so the five list/detail projections cannot drift from each other.
func visitFieldsToDomain(
	id uuid.UUID,
	visitID string,
	vendorUserID uuid.UUID,
	vendorID pgtype.UUID,
	locationID uuid.UUID,
	startDate time.Time,
	endDate time.Time,
	isMultiDay bool,
	status string,
	assignmentLetterURL pgtype.Text,
	isNDAAccepted bool,
	notes pgtype.Text,
	purposeNote pgtype.Text,
	vendorNameOverride pgtype.Text,
	createdAt time.Time,
	updatedAt time.Time,
	vendorName pgtype.Text,
	locationName string,
	locationType string,
	vendorUserName string,
	vendorUserEmail string,
	vendorUserVendorName string,
) (domain.VisitRequest, error) {
	parsed, err := domain.ParseVisitStatus(status)
	if err != nil {
		return domain.VisitRequest{}, err
	}
	return domain.VisitRequest{
		ID:                  mustDomainUUID(id),
		VisitID:             visitID,
		VendorUserID:        mustDomainUUID(vendorUserID),
		VendorID:            nullUUIDToDomain(vendorID),
		LocationID:          mustDomainUUID(locationID),
		LocationName:        locationName,
		LocationType:        domain.LocationType(locationType),
		VendorUserName:      vendorUserName,
		VendorUserEmail:     vendorUserEmail,
		VendorUserVendorName: vendorUserVendorName,
		StartDate:           startDate,
		EndDate:             endDate,
		IsMultiDay:          isMultiDay,
		Status:              parsed,
		AssignmentLetterURL: textPtr(assignmentLetterURL),
		IsNDAAccepted:       isNDAAccepted,
		Notes:               textPtr(notes),
		PurposeNote:         textPtr(purposeNote),
		CreatedAt:           createdAt,
		UpdatedAt:           updatedAt,
		VendorName:          textValue(vendorName),
		VendorNameOverride:  textPtr(vendorNameOverride),
	}, nil
}

// visitorModelToDomain projects one roster row onto the domain roster entry,
// carrying the KTP/SIM photo, the optional selfie (openapi VisitorItem
// id_card_photo_url + photo_url) and the technician's own company
// (vendor_id + resolved vendor_name). The display name funnels through
// resolveVendorDisplayName — the manual override wins only because the write
// path never stores it alongside a vendor_id — so the raw manual text can
// never leak past the resolved public member.
func visitorModelToDomain(row db.ListVisitorsRow) domain.Visitor {
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
	}
}

func dbVisitorToDomain(row db.Visitor, vendorName pgtype.Text) domain.Visitor {
	return domain.Visitor{
		ID:                 mustDomainUUID(row.ID),
		VisitRequestID:     mustDomainUUID(row.VisitRequestID),
		Name:               row.Name,
		IDNumber:           row.IDNumber,
		Phone:              row.Phone,
		IDCardPhotoURL:     textPtr(row.IDCardPhotoUrl),
		PhotoURL:           textPtr(row.PhotoUrl),
		VendorID:           nullUUIDToDomain(row.VendorID),
		VendorName:         resolveVendorDisplayName(row.VendorNameOverride, vendorName),
		VendorNameOverride: textPtr(row.VendorNameOverride),
		Jabatan:            textPtr(row.Jabatan),
		Email:              textPtr(row.Email),
		PhoneEdited:        row.PhoneEdited,
		CreatedAt:          row.CreatedAt,
	}
}

// groupVisitorsByVisit indexes visitor rows by their owning visit id so the
// list path attaches rosters with one batched query per page instead of N+1.
func groupVisitorsByVisit(rows []db.ListVisitorsRow) map[uuid.UUID][]domain.Visitor {
	grouped := make(map[uuid.UUID][]domain.Visitor, len(rows))
	for _, row := range rows {
		visitor := visitorModelToDomain(row)
		grouped[row.VisitRequestID] = append(grouped[row.VisitRequestID], visitor)
	}
	return grouped
}

// purposeModelToDomain projects one visit_purpose join row onto the catalogue
// purpose. The join carries the display name so the wire renders id + name.
func purposeModelToDomain(row db.ListVisitPurposesRow) domain.Purpose {
	return domain.Purpose{
		ID:       mustDomainUUID(row.PurposeID),
		Name:     row.PurposeName,
		IsActive: row.PurposeIsActive,
	}
}

// groupPurposesByVisit indexes purpose rows by their owning visit id so the
// list path attaches catalogues with one batched query per page instead of
// N+1, mirroring groupVisitorsByVisit.
func groupPurposesByVisit(rows []db.ListVisitPurposesRow) map[uuid.UUID][]domain.Purpose {
	grouped := make(map[uuid.UUID][]domain.Purpose, len(rows))
	for _, row := range rows {
		purpose := purposeModelToDomain(row)
		grouped[row.VisitRequestID] = append(grouped[row.VisitRequestID], purpose)
	}
	return grouped
}

// nullUUIDToDomain renders a nullable uuid column as a domain identifier:
// NULL becomes the empty UUID, never the zero-UUID text.
func nullUUIDToDomain(id pgtype.UUID) domain.UUID {
	if !id.Valid {
		return ""
	}
	return toDomainUUID(id.Bytes)
}

// locationRowsToDomain projects the branch-scoped page. Location name/type
// ride along from the location join (kolom Fasilitas FE), same as detail.
// Vendor user name/email ride along from the users join (kartu Informasi Kunjungan).
func locationRowsToDomain(rows []db.ListVisitsForLocationRow) []domain.VisitRequest {
	out := make([]domain.VisitRequest, 0, len(rows))
	for _, row := range rows {
		visit, err := visitFieldsToDomain(
			row.ID, row.VisitID, row.VendorUserID, row.VendorID, row.LocationID,
			row.StartDate, row.EndDate, row.IsMultiDay, row.Status,
			row.AssignmentLetterUrl, row.IsNdaAccepted, row.Notes,
			row.PurposeNote, row.VendorNameOverride,
			row.CreatedAt, row.UpdatedAt, row.VendorName,
			row.LocationName, row.LocationType,
			row.VendorUserName, row.VendorUserEmail, row.VendorUserVendorName,
		)
		if err != nil {
			continue
		}
		out = append(out, visit)
	}
	return out
}

// vendorRowsToDomain projects the vendor-scoped page. Location name/type ride
// along from the location join (kolom Fasilitas FE), same as detail.
// Vendor user name/email ride along from the users join (kartu Informasi Kunjungan).
func vendorRowsToDomain(rows []db.ListVisitsForVendorUserRow) []domain.VisitRequest {
	out := make([]domain.VisitRequest, 0, len(rows))
	for _, row := range rows {
		visit, err := visitFieldsToDomain(
			row.ID, row.VisitID, row.VendorUserID, row.VendorID, row.LocationID,
			row.StartDate, row.EndDate, row.IsMultiDay, row.Status,
			row.AssignmentLetterUrl, row.IsNdaAccepted, row.Notes,
			row.PurposeNote, row.VendorNameOverride,
			row.CreatedAt, row.UpdatedAt, row.VendorName,
			row.LocationName, row.LocationType,
			row.VendorUserName, row.VendorUserEmail, row.VendorUserVendorName,
		)
		if err != nil {
			continue
		}
		out = append(out, visit)
	}
	return out
}

// superAdminRowsToDomain projects the unscoped page. Location name/type ride
// along from the location join (kolom Fasilitas FE), same as detail.
// Vendor user name/email ride along from the users join (kartu Informasi Kunjungan).
func superAdminRowsToDomain(rows []db.ListVisitsForSuperAdminRow) []domain.VisitRequest {
	out := make([]domain.VisitRequest, 0, len(rows))
	for _, row := range rows {
		visit, err := visitFieldsToDomain(
			row.ID, row.VisitID, row.VendorUserID, row.VendorID, row.LocationID,
			row.StartDate, row.EndDate, row.IsMultiDay, row.Status,
			row.AssignmentLetterUrl, row.IsNdaAccepted, row.Notes,
			row.PurposeNote, row.VendorNameOverride,
			row.CreatedAt, row.UpdatedAt, row.VendorName,
			row.LocationName, row.LocationType,
			row.VendorUserName, row.VendorUserEmail, row.VendorUserVendorName,
		)
		if err != nil {
			continue
		}
		out = append(out, visit)
	}
	return out
}
