package visit

import (
	"context"
	"net/http"
	"strings"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/validation"
)

// badRequest builds the 400 validation refusal the contact-correction edge
// answers with: the openapi PATCH documents 400 (not 422) for both malformed
// field values and terminal visits, so the usecase returns the envelope-ready
// AppError directly instead of the 422 ValidationFailure the create path
// uses for the same helpers.
func badRequest(message string) error {
	return &domain.AppError{Status: http.StatusBadRequest, Code: "VALIDATION_ERROR", Message: message}
}

// UpdateVisitorContact corrects one roster member's phone number after the
// visit is created (PATCH /visits/{id}/visitors/{visitorId}). Only the phone
// may be corrected: a sent id_number is refused, and the correction is legal
// only while the visit is still before approval (requested or rescheduled).
// Every other status — approved, visiting or terminal — answers 400.
//
// The edge is creator-only: the actor must be the vendor that owns the visit
// (role vendor AND id == visit.VendorUserID). Every other caller — a vendor
// that does not own the visit, admin, security, even super_admin — answers
// NotFoundEntity("Kunjungan") so the endpoint never reveals whether the visit
// exists, the same hide-existence pattern as reschedule.go and lifecycle.go.
//
// The edited flag turns TRUE only when the normalized new value differs from
// the stored one; an identical value is a no-op success with zero repository
// writes.
func (s *Service) UpdateVisitorContact(ctx context.Context, actor Actor, visitID, visitorID domain.UUID, phone, idNumber *string) (domain.Visitor, error) {
	if phone == nil {
		return domain.Visitor{}, badRequest("Nomor telepon wajib diisi.")
	}
	if idNumber != nil {
		return domain.Visitor{}, badRequest("Hanya nomor telepon yang dapat diubah.")
	}
	visit, err := s.visits.FindByID(ctx, visitID)
	if err != nil {
		return domain.Visitor{}, err
	}
	if actor.Role != domain.RoleVendor || visit.VendorUserID != actor.ID {
		return domain.Visitor{}, domain.NotFoundEntity("Kunjungan")
	}
	if visit.Status != domain.VisitStatusRequested && visit.Status != domain.VisitStatusRescheduled {
		return domain.Visitor{}, badRequest("Data anggota hanya dapat diubah sebelum persetujuan.")
	}
	var target *domain.Visitor
	for i := range visit.Visitors {
		if visit.Visitors[i].ID == visitorID {
			target = &visit.Visitors[i]
			break
		}
	}
	if target == nil {
		return domain.Visitor{}, domain.NotFoundEntity("Anggota")
	}
	newPhone := target.Phone
	phoneEdited := target.PhoneEdited
	trimmed := strings.TrimSpace(*phone)
	if trimmed == "" {
		return domain.Visitor{}, badRequest("Nomor telepon wajib diisi.")
	}
	if validation.PhoneLengthViolation(trimmed) {
		return domain.Visitor{}, badRequest("Nomor telepon harus 10–16 digit angka.")
	}
	if !validation.ValidPhone(trimmed) {
		return domain.Visitor{}, badRequest("Nomor telepon tidak valid.")
	}
	if normalized := validation.NormalizePhone(trimmed); normalized != target.Phone {
		newPhone = normalized
		phoneEdited = true
	}
	if newPhone == target.Phone {
		return *target, nil
	}
	return s.visits.UpdateVisitorContact(ctx, visit.ID, target.ID, newPhone, phoneEdited)
}
