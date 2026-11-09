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
//   - super_admin bebas menunjuk cabang mana pun; admin cabang boleh
//     menunjuk cabang di dalam cakupannya (scope ∪ primary), selain itu 403;
//   - nilai yang terisi harus UUID kanonik, selain itu 400 VALIDATION_ERROR.
func ValidateSecurityLocationMove(actorRole domain.RoleName, raw *string, actorLocation *domain.UUID, scope []domain.UUID) (*domain.UUID, error) {
	if raw == nil {
		return nil, nil
	}
	trimmed := strings.TrimSpace(*raw)
	if trimmed == "" {
		return nil, nil
	}
	parsed, err := domain.ParseUUID(trimmed)
	if err != nil {
		return nil, badRequest("location_id tidak valid.")
	}
	if domain.IsSuperAdminRole(actorRole) {
		return &parsed, nil
	}
	if actorRole != domain.RoleAdmin {
		return nil, forbiddenBranch("Hanya Superadmin yang dapat memindahkan akun security ke cabang lain.")
	}
	allowed := make(map[domain.UUID]struct{})
	if scope == nil {
		if actorLocation != nil {
			allowed[*actorLocation] = struct{}{}
		}
	} else {
		for _, id := range scope {
			allowed[id] = struct{}{}
		}
		if actorLocation != nil {
			allowed[*actorLocation] = struct{}{}
		}
	}
	if _, ok := allowed[parsed]; !ok {
		return nil, forbiddenBranch("Tidak berhak memindahkan akun security ke cabang lain.")
	}
	return &parsed, nil
}
