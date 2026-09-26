package handlers

import (
	"time"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/visit"
)

// DTOs in this file mirror docs/4. openapi.yaml L770-913 field for field.
// Every JSON key emitted must exist in the corresponding schema; the contract
// test pins that. No handler adds a key of its own.

// visitorDTO mirrors VisitorItem: name/id_number/phone plus the optional
// id_card_photo_url uploaded beforehand via POST /uploads (id_card).
type visitorDTO struct {
	Name           string  `json:"name"`
	IDNumber       string  `json:"id_number"`
	Phone          string  `json:"phone"`
	IDCardPhotoURL *string `json:"id_card_photo_url,omitempty"`
}

// locationDTO mirrors Location. The visit usecase returns the location id
// only, so the handler emits the id member and leaves the catalogue detail to
// the master endpoints; every member stays optional per the schema.
type locationDTO struct {
	ID   string  `json:"id"`
	Name *string `json:"name,omitempty"`
}

// purposeDTO mirrors Purpose. Same partial rule as locationDTO.
type purposeDTO struct {
	ID   string  `json:"id"`
	Name *string `json:"name,omitempty"`
}

// userDTO mirrors User. The handler knows the pic id only, so it emits the
// id member; profile detail belongs to the user endpoints.
type userDTO struct {
	ID string `json:"id"`
}

// visitDetailDTO mirrors VisitDetail. Field notes: vendor_name is empty until
// a vendor join is wired (the usecase returns VendorID only); purposes and
// visitors default to empty arrays so the keys are always present.
type visitDetailDTO struct {
	ID                  string       `json:"id"`
	VisitID             string       `json:"visit_id"`
	Status              string       `json:"status"`
	Location            locationDTO  `json:"location"`
	Purposes            []purposeDTO `json:"purposes"`
	PICUser             userDTO      `json:"pic_user"`
	VendorName          string       `json:"vendor_name"`
	StartDate           string       `json:"start_date"`
	EndDate             string       `json:"end_date"`
	AssignmentLetterURL *string      `json:"assignment_letter_url"`
	Notes               string       `json:"notes"`
	Visitors            []visitorDTO `json:"visitors"`
	CreatedAt           string       `json:"created_at"`
}

// visitListDTO mirrors the VisitListResponse data object: {items, total,
// page, limit}. It is never a bare array.
type visitListDTO struct {
	Items []visitDetailDTO `json:"items"`
	Total int64            `json:"total"`
	Page  int              `json:"page"`
	Limit int              `json:"limit"`
}

// qrDTO mirrors the GET /visits/{id}/qr data object: exactly visit_id and
// qr_code_payload, no format member.
type qrDTO struct {
	VisitID       string `json:"visit_id"`
	QRCodePayload string `json:"qr_code_payload"`
}

// uploadDTO mirrors the UploadFileResponse data object.
type uploadDTO struct {
	FileURL  string `json:"file_url"`
	FileName string `json:"file_name"`
	FileSize int64  `json:"file_size"`
	MimeType string `json:"mime_type"`
}

// createVisitBody mirrors CreateVisitRequest. is_multi_day is accepted but
// ignored: the usecase DERIVES multi-day from the schedule window.
type createVisitBody struct {
	LocationID          string   `json:"location_id"`
	PurposeIDs          []string `json:"purpose_ids"`
	StartDate           string   `json:"start_date"`
	EndDate             string   `json:"end_date"`
	IsMultiDay          bool     `json:"is_multi_day"`
	AssignmentLetterURL *string  `json:"assignment_letter_url"`
	IsNDAAccepted       *bool    `json:"is_nda_accepted"`
	Notes               string   `json:"notes"`
	Visitors            []struct {
		Name           string  `json:"name"`
		IDNumber       string  `json:"id_number"`
		Phone          string  `json:"phone"`
		IDCardPhotoURL *string `json:"id_card_photo_url"`
	} `json:"visitors"`
}

// toVisitDetail maps one domain visit onto the openapi VisitDetail shape.
// Text pointers render as null when absent, matching the [string, "null"]
// schema members; slices stay non-nil so they render as [] instead of null.
func toVisitDetail(v domain.VisitRequest) visitDetailDTO {
	detail := visitDetailDTO{
		ID:        string(v.ID),
		VisitID:   v.VisitID,
		Status:    string(v.Status),
		Location:  locationDTO{ID: string(v.LocationID)},
		Purposes:  []purposeDTO{},
		PICUser:   userDTO{ID: string(v.PICUserID)},
		StartDate: v.StartDate.Format(time.RFC3339),
		EndDate:   v.EndDate.Format(time.RFC3339),
		Visitors:  []visitorDTO{},
		CreatedAt: v.CreatedAt.Format(time.RFC3339),
	}
	if v.AssignmentLetterURL != nil {
		url := *v.AssignmentLetterURL
		detail.AssignmentLetterURL = &url
	}
	if v.Notes != nil {
		detail.Notes = *v.Notes
	}
	return detail
}

// toCreateInput maps the bound body onto visit.CreateVisitInput.
func toCreateInput(body createVisitBody, start, end time.Time) visit.CreateVisitInput {
	in := visit.CreateVisitInput{
		LocationID:    domain.UUID(body.LocationID),
		StartDate:     start,
		EndDate:       end,
		Notes:         body.Notes,
		IsNDAAccepted: body.IsNDAAccepted != nil && *body.IsNDAAccepted,
	}
	if body.AssignmentLetterURL != nil {
		url := *body.AssignmentLetterURL
		in.AssignmentLetterURL = &url
	}
	for _, pid := range body.PurposeIDs {
		in.PurposeIDs = append(in.PurposeIDs, domain.UUID(pid))
	}
	for _, w := range body.Visitors {
		visitor := visit.VisitorInput{Name: w.Name, IDNumber: w.IDNumber, Phone: w.Phone}
		if w.IDCardPhotoURL != nil {
			photo := *w.IDCardPhotoURL
			visitor.IDCardPhotoURL = &photo
		}
		in.Visitors = append(in.Visitors, visitor)
	}
	return in
}

// withEchoedVisitors attaches the request visitors to a created detail. The
// repository returns the visit row without its visitor rows, so echoing the
// just-validated input is the only honest visitor data the create response
// can carry.
func withEchoedVisitors(detail visitDetailDTO, in visit.CreateVisitInput) visitDetailDTO {
	detail.Purposes = make([]purposeDTO, 0, len(in.PurposeIDs))
	for _, pid := range in.PurposeIDs {
		detail.Purposes = append(detail.Purposes, purposeDTO{ID: string(pid)})
	}
	detail.Visitors = make([]visitorDTO, 0, len(in.Visitors))
	for _, w := range in.Visitors {
		detail.Visitors = append(detail.Visitors, visitorDTO{
			Name: w.Name, IDNumber: w.IDNumber, Phone: w.Phone, IDCardPhotoURL: w.IDCardPhotoURL,
		})
	}
	return detail
}

// toUploadDTO maps a storage result onto the UploadFileResponse data object.
func toUploadDTO(result domain.UploadResult) uploadDTO {
	return uploadDTO{
		FileURL:  result.FileURL,
		FileName: result.FileName,
		FileSize: result.FileSize,
		MimeType: result.MimeType,
	}
}
