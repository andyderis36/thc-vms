package superadmin

import (
	"thc-vms/backend/internal/domain"
)

// ResolveLocationUnion applies the accept-either rule shared by the account
// writes (POST/PATCH /users, POST/PATCH /users/security): a present
// location_ids list wins as the union with the primary forced first,
// otherwise the union is the primary alone. A nil ids means the key was
// absent; callers reject an explicitly empty list before calling (400).
// The returned union is deduped, so the (user_id, location_id) primary key
// can never see a duplicate row.
func ResolveLocationUnion(primary *domain.UUID, ids []domain.UUID) (effPrimary *domain.UUID, union []domain.UUID) {
	if ids == nil {
		if primary == nil {
			return nil, nil
		}
		return primary, []domain.UUID{*primary}
	}
	// Present-but-empty stays empty so the validators can refuse the
	// explicit [] with 400 instead of silently collapsing to the primary.
	if len(ids) == 0 {
		return primary, []domain.UUID{}
	}
	effPrimary = primary
	if effPrimary == nil {
		effPrimary = &ids[0]
	}
	seen := make(map[domain.UUID]struct{}, len(ids)+1)
	union = make([]domain.UUID, 0, len(ids)+1)
	for _, id := range append([]domain.UUID{*effPrimary}, ids...) {
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		union = append(union, id)
	}
	return effPrimary, union
}

// CheckBranchScope refuses an account write whose union leaves the caller's
// branch scope: super_admin is unrestricted, every other branch-bound caller
// may only name locations inside its scope (the stashed user_locations union,
// falling back to the scalar primary when no stash is present). It runs
// before any write or catalogue read so an out-of-scope id is a pure 403
// with zero side effects.
//
// scope is the stashed branch union (nil = no stash present, fall back to
// the scalar primary); a non-nil slice (even empty) is treated as an
// authoritative stash and is unioned with the scalar primary so a caller
// whose coverage rows are missing still keeps its own branch.
func CheckBranchScope(actorRole domain.RoleName, actorLocation *domain.UUID, scope []domain.UUID, union []domain.UUID) error {
	if len(union) == 0 {
		return nil
	}
	if domain.IsSuperAdminRole(actorRole) {
		return nil
	}
	if actorRole != domain.RoleAdmin {
		return forbiddenBranch("Tidak berhak mengelola akun cabang lain.")
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
	if len(allowed) == 0 {
		return forbiddenBranch("Tidak berhak mengelola akun cabang lain.")
	}
	for _, id := range union {
		if _, ok := allowed[id]; !ok {
			return forbiddenBranch("Tidak berhak mengelola akun cabang lain.")
		}
	}
	return nil
}

// ValidateSecurityLocationIDs governs the location_ids member of the
// security MOVE (PATCH /users/security/:id): super_admin and branch admin
// may send it; scope is enforced later by CheckBranchScope once the ids are
// parsed. A branch admin sending an out-of-scope id is refused with 403.
func ValidateSecurityLocationIDs(actorRole domain.RoleName, present bool) error {
	if !present {
		return nil
	}
	if !domain.IsSuperAdminRole(actorRole) && actorRole != domain.RoleAdmin {
		return forbiddenBranch("Hanya Superadmin yang dapat memindahkan akun security ke cabang lain.")
	}
	return nil
}
