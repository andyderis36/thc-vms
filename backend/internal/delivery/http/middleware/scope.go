// Scope resolution for multi-branch isolation (migration 000023): the
// per-request branch union behind the thc.scope stash. The JWT middleware
// resolves once per request through AccessibleLocationIDs and stashes the
// result; CheckBranchFor is the request-aware twin of CheckBranch that branch
// write paths mount. Listing queries stay scalar in this wave: nothing here
// changes what any read returns, it only records the union the later wave
// flips the reads to.
package middleware

import (
	"context"

	"github.com/gin-gonic/gin"

	deliveryhttp "thc-vms/backend/internal/delivery/http"
	"thc-vms/backend/internal/domain"
)

// ScopeStore loads the branch-coverage union of one user from
// user_locations. It is satisfied structurally by the PostgreSQL adapter, so
// this package never imports the repository layer (same seam shape as
// TokenParser and ProfileLoader in jwt.go).
type ScopeStore interface {
	ListUserLocationIDs(ctx context.Context, userID domain.UUID) ([]domain.UUID, error)
}

// AccessibleLocationIDs resolves the branch union one request may touch for
// the given caller. super_admin and the hidden dev-superadmin resolve global
// (nil, true) and vendor resolves non-global (nil, false): all three return
// before the join table is read, so the owner path downstream is untouched.
// Every other role resolves exactly its user_locations union for actor.ID. A
// store failure returns the error with an empty non-global scope so every
// caller fails closed.
func AccessibleLocationIDs(ctx context.Context, actor deliveryhttp.Identity, store ScopeStore) ([]domain.UUID, bool, error) {
	if domain.IsSuperAdminRole(actor.Role) {
		return nil, true, nil
	}
	if actor.Role == domain.RoleVendor {
		return nil, false, nil
	}
	ids, err := store.ListUserLocationIDs(ctx, actor.UserID)
	if err != nil {
		return nil, false, err
	}
	return ids, false, nil
}

// CheckBranchFor enforces multi-branch isolation for one target branch on the
// live request: it reads the caller and the stashed union from the gin
// context. super_admin passes everywhere exactly like CheckBranch; a target
// inside the stashed union passes even when it differs from the scalar
// primary; anything else falls through to CheckBranch, so callers without a
// stash (and accounts whose coverage rows are not yet written) decide exactly
// as before. Anonymous callers get the 401 sentinel, never a scope decision.
func CheckBranchFor(c *gin.Context, target domain.UUID) error {
	id, ok := deliveryhttp.IdentityFrom(c)
	if !ok {
		return domain.ErrUnauthorized
	}
	if domain.IsSuperAdminRole(id.Role) {
		return nil
	}
	if scope, ok := deliveryhttp.ScopeFrom(c); ok {
		for _, locationID := range scope.LocationIDs {
			if locationID == target {
				return nil
			}
		}
	}
	return CheckBranch(id, target)
}
