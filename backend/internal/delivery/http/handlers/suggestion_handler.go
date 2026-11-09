package handlers

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/response"
	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/visit"
	"thc-vms/backend/internal/validation"
)

// vendorSuggestionDTO mirrors the VendorSuggestion schema: the deduped display
// name plus the source it won (master|account|history).
type vendorSuggestionDTO struct {
	Name   string `json:"name"`
	Source string `json:"source"`
}

// memberSuggestionDTO mirrors MemberSuggestion. It is deliberately photo-less:
// id_card_photo_url/photo_url exist only on the single-member pick response.
// visitor_id lets the client resolve the detail endpoint for the winning row.
type memberSuggestionDTO struct {
	Name          string  `json:"name"`
	IDNumber      string  `json:"id_number"`
	Phone         string  `json:"phone"`
	Email         *string `json:"email"`
	Jabatan       *string `json:"jabatan"`
	LastVisitAt   string  `json:"last_visit_at"`
	VisitorID     string  `json:"visitor_id"`
	SourceVisitID string  `json:"source_visit_id"`
}

// memberSuggestionDetailDTO mirrors MemberSuggestionDetail: the picked member
// with the presigned KTP/selfie links for autofill. vendor_name is the
// member's own company, not the visit-level "Vendor Pengaju".
type memberSuggestionDetailDTO struct {
	Name           string  `json:"name"`
	IDNumber       string  `json:"id_number"`
	Phone          string  `json:"phone"`
	Email          *string `json:"email"`
	Jabatan        *string `json:"jabatan"`
	VendorName     *string `json:"vendor_name"`
	IDCardPhotoURL *string `json:"id_card_photo_url"`
	PhotoURL       *string `json:"photo_url"`
	SourceVisitID  string  `json:"source_visit_id"`
}

// ListVendorSuggestions serves GET /vendors/suggestions. The role gate and the
// branch/global scope live in the usecase; this handler only maps HTTP.
func (h *VisitHandler) ListVendorSuggestions(c *gin.Context) {
	actor, err := visitActor(c)
	if err != nil {
		response.Fail(c, err)
		return
	}
	query, ok := suggestionQueryParam(c)
	if !ok {
		return
	}
	items, err := h.visits.ListVendorSuggestions(c.Request.Context(), actor, query)
	if err != nil {
		response.Fail(c, err)
		return
	}
	out := make([]vendorSuggestionDTO, 0, len(items))
	for _, item := range items {
		out = append(out, vendorSuggestionDTO{Name: item.Name, Source: string(item.Source)})
	}
	response.OK(c, out)
}

// ListMemberSuggestions serves GET /visits/member-suggestions. ?vendor= is the
// optional display-name narrow for admin/super_admin; a vendor caller's value
// is ignored by the usecase because ownership is its entire scope. There is
// deliberately no vendor_user_id read on this path (PII enumeration risk).
func (h *VisitHandler) ListMemberSuggestions(c *gin.Context) {
	actor, err := visitActor(c)
	if err != nil {
		response.Fail(c, err)
		return
	}
	query, ok := suggestionQueryParam(c)
	if !ok {
		return
	}
	in := visit.MemberSuggestionsInput{Query: query, Vendor: strings.TrimSpace(c.Query("vendor"))}
	items, err := h.visits.ListMemberSuggestions(c.Request.Context(), actor, in)
	if err != nil {
		response.Fail(c, err)
		return
	}
	out := make([]memberSuggestionDTO, 0, len(items))
	for _, item := range items {
		out = append(out, memberSuggestionDTO{
			Name:          item.Name,
			IDNumber:      item.IDNumber,
			Phone:         item.Phone,
			Email:         item.Email,
			Jabatan:       item.Jabatan,
			LastVisitAt:   item.LastVisitAt.Format(time.RFC3339),
			VisitorID:     string(item.VisitorID),
			SourceVisitID: string(item.SourceVisitID),
		})
	}
	response.OK(c, out)
}

// GetMemberSuggestion serves GET /visits/member-suggestions/{visitorId}. A
// malformed or empty id answers the same 404 as an unknown one so the route
// never confirms whether a visitor exists.
func (h *VisitHandler) GetMemberSuggestion(c *gin.Context) {
	actor, err := visitActor(c)
	if err != nil {
		response.Fail(c, err)
		return
	}
	raw := strings.TrimSpace(c.Param("visitorId"))
	visitorID, parseErr := domain.ParseUUID(raw)
	if raw == "" || parseErr != nil {
		response.Fail(c, domain.NotFoundEntity("Anggota"))
		return
	}
	detail, err := h.visits.GetMemberSuggestion(c.Request.Context(), actor, visitorID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, memberSuggestionDetailDTO{
		Name:           detail.Name,
		IDNumber:       detail.IDNumber,
		Phone:          detail.Phone,
		Email:          detail.Email,
		Jabatan:        detail.Jabatan,
		VendorName:     detail.VendorName,
		IDCardPhotoURL: detail.IDCardPhotoURL,
		PhotoURL:       detail.PhotoURL,
		SourceVisitID:  string(detail.SourceVisitID),
	})
}

// suggestionQueryParam reads the shared ?q= filter: trimmed, empty means
// unfiltered, and one past the cap is the same 400 VALIDATION_ERROR shape the
// other query errors use.
func suggestionQueryParam(c *gin.Context) (string, bool) {
	query := strings.TrimSpace(c.Query("q"))
	if validation.RuneLen(query) > validation.SuggestionQueryMaxLength {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR",
			"Kata kunci pencarian maksimal "+strconv.Itoa(validation.SuggestionQueryMaxLength)+" karakter.")
		return "", false
	}
	return query, true
}
