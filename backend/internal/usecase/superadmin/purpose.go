package superadmin

import (
	"fmt"
	"strconv"
	"strings"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/validation"
)

// ValidatePurposeCreate rejects a POST /purposes body before it reaches the
// store. The name is mandatory and capped at PurposeNameMaxLength.
func ValidatePurposeCreate(name string) error {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return badRequest("Nama tujuan kunjungan wajib diisi.")
	}
	if validation.RuneLen(trimmed) > validation.PurposeNameMaxLength {
		return badRequest("Nama tujuan kunjungan maksimal " + strconv.Itoa(validation.PurposeNameMaxLength) + " karakter.")
	}
	return nil
}

// ValidatePurposePatch rejects a PATCH /purposes/:id body: at least one
// member must be present, and a provided name must be non-blank and capped.
func ValidatePurposePatch(patch domain.PurposePatch) error {
	if patch.Name == nil && patch.IsActive == nil {
		return badRequest("Tidak ada field yang diubah.")
	}
	if patch.Name != nil {
		trimmed := strings.TrimSpace(*patch.Name)
		if trimmed == "" {
			return badRequest("Nama tujuan kunjungan wajib diisi.")
		}
		if validation.RuneLen(trimmed) > validation.PurposeNameMaxLength {
			return badRequest("Nama tujuan kunjungan maksimal " + strconv.Itoa(validation.PurposeNameMaxLength) + " karakter.")
		}
	}
	return nil
}

// CheckPurposeReferences guards DELETE /purposes/:id: a purpose still linked
// from visit_purpose rows refuses with 409 naming the blocker. The count
// comes from the repository pre-check; the database FK (23503 -> 409 via
// MapError) is the second line of defence for a reference that races the
// check.
func CheckPurposeReferences(visits int64) error {
	if visits > 0 {
		return domain.Conflict(fmt.Sprintf(
			"Tujuan kunjungan masih dipakai %d kunjungan dan tidak dapat dihapus. Hapus kunjungan tersebut terlebih dahulu.", visits))
	}
	return nil
}
