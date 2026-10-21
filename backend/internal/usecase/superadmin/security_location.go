package superadmin

import (
	"net/http"
	"strings"

	"thc-vms/backend/internal/domain"
)

// forbiddenBranch builds the 403 for a refused BRANCH-scoped account write.
// The code matches the branch-isolation vocabulary of the delivery layer
// (FORBIDDEN_BRANCH, sama dengan penolakan lintas cabang lain di endpoint
// pengawas), sedangkan pesannya menyebut penolakan yang tepat.
func forbiddenBranch(message string) *domain.AppError {
	return &domain.AppError{Status: http.StatusForbidden, Code: "FORBIDDEN_BRANCH", Message: message}
}

// ValidateSecurityLocationMove governs the location_id member of
// PATCH /users/security/:id (mutasi cabang penugasan satpam):
//
//   - member yang ABSEN (atau null) berarti "biarkan cabang saat ini" —
//     hasilnya nil, jadi penulisan tak pernah menyentuh kolom lokasi;
//   - HANYA super_admin boleh menunjuk cabang lain. Admin cabang ditolak
//     403 walau menunjuk cabangnya sendiri: cabang penugasan satpam adalah
//     keputusan kantor pusat, dan field ini tak boleh jadi jalan memindahkan
//     orang antar cabang;
//   - nilai yang terisi harus UUID kanonik, selain itu 400 VALIDATION_ERROR.
//
// Nilai balik adalah cabang yang harus ditulis (nil = pertahankan cabang
// tersimpan). Keberadaan baris kanalognya dicek di lapisan delivery (port
// master data), bukan di sini: aturan ini murni nilai, tanpa database.
func ValidateSecurityLocationMove(actorRole domain.RoleName, raw *string) (*domain.UUID, error) {
	if raw == nil {
		return nil, nil
	}
	if actorRole != domain.RoleSuperAdmin {
		return nil, forbiddenBranch("Hanya Superadmin yang dapat memindahkan akun security ke cabang lain.")
	}
	trimmed := strings.TrimSpace(*raw)
	if trimmed == "" {
		return nil, nil
	}
	parsed, err := domain.ParseUUID(trimmed)
	if err != nil {
		return nil, badRequest("location_id tidak valid.")
	}
	return &parsed, nil
}
