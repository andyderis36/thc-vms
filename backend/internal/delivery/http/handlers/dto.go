package handlers

import (
	"strings"
	"time"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/visit"
	"thc-vms/backend/internal/validation"
)

// DTOs in this file mirror docs/4. openapi.yaml L770-913 field for field.
// Every JSON key emitted must exist in the corresponding schema; the contract
// test pins that. No handler adds a key of its own.

// visitorDTO mirrors VisitorItem: name/id_number/phone plus the optional
// id_card_photo_url, photo_url (selfie) and vendor_id uploaded beforehand,
// with the resolved vendor_name alongside. ID carries the visitor row UUID on
// reads (omitted on create-echo, which has no stored rows yet); the gate file
// endpoint requires it, so callers must use ID, never id_number.
type visitorDTO struct {
	ID             *string `json:"id,omitempty"`
	Name           string  `json:"name"`
	IDNumber       string  `json:"id_number"`
	Phone          string  `json:"phone"`
	IDCardPhotoURL *string `json:"id_card_photo_url,omitempty"`
	PhotoURL       *string `json:"photo_url,omitempty"`
	VendorID       *string `json:"vendor_id,omitempty"`
	VendorName     *string `json:"vendor_name,omitempty"`
	// Jabatan is the optional free-text position (migration 000012); it is
	// never a catalogue member and renders omitted when absent.
	Jabatan *string `json:"jabatan,omitempty"`
	// Email is the optional member contact address (migration 000022),
	// used only as the notification-mail recipient; omitted when absent.
	Email *string `json:"email,omitempty"`
	// PhoneEdited is the persistent marker of the creator contact correction
	// (migration 000021, PATCH /visits/{id}/visitors/{visitorId}). It always
	// renders, even false: false means the phone was never corrected after
	// submission.
	PhoneEdited bool `json:"phone_edited"`
}

// locationDTO mirrors Location. Name/type ride along from the usecase join
// (kolom Fasilitas FE); empty renders nil/omitted, same partial rule as
// purposeDTO. Every member stays optional per the schema.
type locationDTO struct {
	ID   string  `json:"id"`
	Name *string `json:"name,omitempty"`
	Type *string `json:"type,omitempty"`
}

// purposeDTO mirrors Purpose. Same partial rule as locationDTO.
type purposeDTO struct {
	ID   string  `json:"id"`
	Name *string `json:"name,omitempty"`
}

// userDTO mirrors User. Id is always present; name/email ride along from the
// visit join (kartu Informasi Kunjungan FE). Empty renders nil/omitted, same
// partial rule as locationDTO (User has no required members in openapi).
// VendorName carries the requesting vendor account's own company
// (COALESCE(users.vendor_name_override, vendor.name)); nil when the account
// carries no company.
type userDTO struct {
	ID         string  `json:"id"`
	Name       *string `json:"name,omitempty"`
	Email      *string `json:"email,omitempty"`
	VendorName *string `json:"vendor_name,omitempty"`
}

// visitDetailDTO mirrors VisitDetail. Field notes: vendor_name carries the
// catalogue display name resolved by the usecase (empty when the visit names
// no vendor); visitors come from the domain roster on reads and from the
// echoed request input on create. purposes default to empty arrays so the
// keys are always present. check_in_at / check_out_at / checked_in_by are
// gate enrichment filled ONLY by the single-GET path (usecase withGateTimes);
// list items leave them nil so the keys are omitted, and requested/approved
// visits render no gate keys at all.
type visitDetailDTO struct {
	ID         string       `json:"id"`
	VisitID    string       `json:"visit_id"`
	Status     string       `json:"status"`
	Location   locationDTO  `json:"location"`
	Purposes   []purposeDTO `json:"purposes"`
	VendorUser userDTO      `json:"vendor_user"`
	// LegacyPICUser adalah alias USANG dari VendorUser yang dipertahankan
	// HANYA selama fase transisi rename PIC -> VendorUser ini, agar tab browser
	// dengan bundle frontend lama yang masih membaca `pic_user` tetap berfungsi.
	// Nilainya SELALU identik dengan VendorUser dan field ini dihapus pada fase
	// berikutnya; jangan pakai untuk logika baru.
	LegacyPICUser       userDTO `json:"pic_user"`
	VendorName          string  `json:"vendor_name"`
	StartDate           string  `json:"start_date"`
	EndDate             string  `json:"end_date"`
	AssignmentLetterURL *string `json:"assignment_letter_url"`
	Notes               string  `json:"notes"`
	// PurposeNote mirrors VisitDetail.purpose_note (migration 000005): no
	// omitempty so the key is always present, null when the visit carries no
	// free-typed purpose.
	PurposeNote *string      `json:"purpose_note"`
	// StatusNote mirrors VisitDetail.status_note: the note of the current
	// status transition (rejection/cancellation/reschedule reason). Null when
	// the transition carried no note.
	StatusNote *string      `json:"status_note"`
	Visitors    []visitorDTO `json:"visitors"`
	CreatedAt   string       `json:"created_at"`
	CheckInAt   *string      `json:"check_in_at,omitempty"`
	CheckOutAt  *string      `json:"check_out_at,omitempty"`
	CheckedInBy *string      `json:"checked_in_by,omitempty"`
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
// visitors[].vendor_id is the technician's own company (optional);
// visitors[].photo_url is the optional selfie uploaded via the id_card
// upload category.
type createVisitBody struct {
	LocationID string   `json:"location_id"`
	// VendorName is the manually typed visit-level company (migration 000017),
	// honoured for admin/superadmin-created visits; it never enters the
	// vendor catalogue.
	VendorName *string  `json:"vendor_name"`
	PurposeIDs []string `json:"purpose_ids"`
	// PurposeNote is the free-typed "tujuan lain" (migration 000005): either
	// a non-empty purpose_ids or a non-empty purpose_note is required.
	PurposeNote string `json:"purpose_note"`
	StartDate   string `json:"start_date"`
	EndDate     string `json:"end_date"`
	IsMultiDay  bool   `json:"is_multi_day"`
	// AssignmentLetterURL is mandatory on CREATE (binding required); the
	// exact FE-aligned wording comes from checkCreateBody, which also
	// rejects the empty/whitespace case this tag cannot see.
	AssignmentLetterURL *string `json:"assignment_letter_url" binding:"required"`
	IsNDAAccepted       *bool   `json:"is_nda_accepted"`
	Notes               string  `json:"notes"`
	Visitors            []struct {
		Name           string  `json:"name"`
		IDNumber       string  `json:"id_number"`
		Phone          string  `json:"phone"`
		IDCardPhotoURL *string `json:"id_card_photo_url"`
		PhotoURL       *string `json:"photo_url"`
		VendorID       *string `json:"vendor_id"`
		// VendorName is the manually typed company (migration 000005),
		// honoured only when vendor_id is absent; it never enters the
		// vendor catalogue.
		VendorName *string `json:"vendor_name"`
		// Jabatan is the optional free-text position (migration 000012); the
		// usecase trims it, caps it at 120 and maps a blank input to absent.
		Jabatan *string `json:"jabatan"`
		// Email is the optional member contact address (migration 000022);
		// the usecase trims it, validates it and maps a blank input to
		// absent, so the echo cannot carry whitespace.
		Email *string `json:"email"`
	} `json:"visitors"`
}

// toVisitorDTO maps one domain roster entry onto the openapi VisitorItem
// shape. It is shared by the visit detail roster and the single-member
// PATCH /visits/{id}/visitors/{visitorId} response so both render the same
// keys, including the migration 000021 edited markers.
func toVisitorDTO(w domain.Visitor) visitorDTO {
	dto := visitorDTO{
		Name: w.Name, IDNumber: w.IDNumber, Phone: w.Phone,
		IDCardPhotoURL: w.IDCardPhotoURL, PhotoURL: w.PhotoURL,
		Jabatan: w.Jabatan, Email: w.Email,
		PhoneEdited: w.PhoneEdited,
	}
	if w.ID != "" {
		id := string(w.ID)
		dto.ID = &id
	}
	if w.VendorID != "" {
		id := string(w.VendorID)
		dto.VendorID = &id
	}
	if w.VendorName != "" {
		name := w.VendorName
		dto.VendorName = &name
	}
	return dto
}

// toVisitDetail maps one domain visit onto the openapi VisitDetail shape.
// Text pointers render as null when absent, matching the [string, "null"]
// schema members; slices stay non-nil so they render as [] instead of null.
// The roster (including photo_url) and vendor_name travel from the domain
// visit: reads carry the repository-loaded roster, create carries the
// re-read GET enrichment (handler re-reads the created row before 201).
func toVisitDetail(v domain.VisitRequest) visitDetailDTO {
	loc := locationDTO{ID: string(v.LocationID)}
	if v.LocationName != "" {
		name := v.LocationName
		loc.Name = &name
	}
	if v.LocationType != "" {
		typ := string(v.LocationType)
		loc.Type = &typ
	}
	// The wire vendor_name prefers the manual visit-level company (migration
	// 000017) when the trimmed text is present, otherwise the catalogue
	// display name resolved by the repository.
	vendorName := v.VendorName
	if v.VendorNameOverride != nil && strings.TrimSpace(*v.VendorNameOverride) != "" {
		vendorName = strings.TrimSpace(*v.VendorNameOverride)
	}
	detail := visitDetailDTO{
		ID:         string(v.ID),
		VisitID:    v.VisitID,
		Status:     string(v.Status),
		Location:   loc,
		Purposes:   []purposeDTO{},
		VendorUser: userDTO{ID: string(v.VendorUserID)},
		VendorName: vendorName,
		StartDate:  v.StartDate.Format(time.RFC3339),
		EndDate:    v.EndDate.Format(time.RFC3339),
		Visitors:   []visitorDTO{},
		CreatedAt:  v.CreatedAt.Format(time.RFC3339),
	}
	if v.VendorUserName != "" {
		name := v.VendorUserName
		detail.VendorUser.Name = &name
	}
	if v.VendorUserEmail != "" {
		email := v.VendorUserEmail
		detail.VendorUser.Email = &email
	}
	if strings.TrimSpace(v.VendorUserVendorName) != "" {
		company := strings.TrimSpace(v.VendorUserVendorName)
		detail.VendorUser.VendorName = &company
	}
	// The deprecated pic_user alias always mirrors vendor_user byte for byte so
	// a stale frontend bundle keeps rendering the visitor card unchanged.
	detail.LegacyPICUser = detail.VendorUser
	for _, p := range v.Purposes {
		dto := purposeDTO{ID: string(p.ID)}
		if p.Name != "" {
			name := p.Name
			dto.Name = &name
		}
		detail.Purposes = append(detail.Purposes, dto)
	}
	for _, w := range v.Visitors {
		detail.Visitors = append(detail.Visitors, toVisitorDTO(w))
	}
	if v.AssignmentLetterURL != nil {
		url := *v.AssignmentLetterURL
		detail.AssignmentLetterURL = &url
	}
	if v.Notes != nil {
		detail.Notes = *v.Notes
	}
	// The free-typed purpose travels verbatim from the domain row (nil stays
	// null on the wire); the roster vendor_name below is the RESOLVED display
	// name carried by the domain visit, never the raw manual input, so a
	// catalogue win can never leak the discarded manual text.
	detail.PurposeNote = v.PurposeNote
	detail.StatusNote = v.StatusNote
	// Gate times come from the usecase enrichment, never invented here: nil
	// pointers stay absent (omitempty) for requested/approved visits and for
	// every list item, while visiting/completed single-GETs render RFC3339.
	if v.CheckInAt != nil {
		at := v.CheckInAt.Format(time.RFC3339)
		detail.CheckInAt = &at
	}
	if v.CheckOutAt != nil {
		at := v.CheckOutAt.Format(time.RFC3339)
		detail.CheckOutAt = &at
	}
	if v.CheckedInBy != nil {
		by := string(*v.CheckedInBy)
		detail.CheckedInBy = &by
	}
	return detail
}

// toCreateInput maps the bound body onto visit.CreateVisitInput. The body is
// assumed to have passed checkCreateBody, so a present vendor_id is already a
// well-formed UUID here.
func toCreateInput(body createVisitBody, start, end time.Time) visit.CreateVisitInput {
	in := visit.CreateVisitInput{
		LocationID:    domain.UUID(body.LocationID),
		StartDate:     start,
		EndDate:       end,
		Notes:         body.Notes,
		PurposeNote:   body.PurposeNote,
		VendorName:    body.VendorName,
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
		// Phone is persisted in canonical form (digits only, 62 -> 0) so the
		// column never carries spaces, dashes or stray letters.
		visitor := visit.VisitorInput{Name: w.Name, IDNumber: w.IDNumber, Phone: validation.NormalizePhone(w.Phone)}
		if w.IDCardPhotoURL != nil {
			photo := *w.IDCardPhotoURL
			visitor.IDCardPhotoURL = &photo
		}
		if w.PhotoURL != nil {
			selfie := *w.PhotoURL
			visitor.PhotoURL = &selfie
		}
		if w.VendorID != nil {
			if id := strings.TrimSpace(*w.VendorID); id != "" {
				vendorID := domain.UUID(id)
				visitor.VendorID = &vendorID
			}
		}
		// The manual company travels as-is; the usecase trims, caps and
		// applies the catalogue-wins rule, so the response echo can never
		// carry the raw text when a vendor_id was also sent.
		if w.VendorName != nil {
			name := *w.VendorName
			visitor.VendorName = &name
		}
		// The position travels as-is; the usecase trims it, caps it and
		// stores a blank input as absent, so the echo cannot carry whitespace.
		if w.Jabatan != nil {
			jabatan := *w.Jabatan
			visitor.Jabatan = &jabatan
		}
		// The member address travels as-is; the usecase trims it, validates
		// it and stores a blank input as absent, so the echo cannot carry
		// whitespace.
		if w.Email != nil {
			email := *w.Email
			visitor.Email = &email
		}
		in.Visitors = append(in.Visitors, visitor)
	}
	return in
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
