package middleware

import (
	"github.com/gin-gonic/gin"

	deliveryhttp "thc-vms/backend/internal/delivery/http"
	"thc-vms/backend/internal/delivery/http/response"
	"thc-vms/backend/internal/domain"
)

// RequireRoles is MW3's role gate: only callers carrying one of the allowed
// roles pass. Anonymous callers get the 401 envelope; the wrong role gets
// 403 with the sentinel's exact message, read from domain.ErrForbiddenBranch
// and never retyped. vendor is refused on every administrative route by simply
// never listing it among the allowed roles. The hidden dev-superadmin passes
// wherever super_admin is allowed, without being named at any call site.
func RequireRoles(allowed ...domain.RoleName) gin.HandlerFunc {
	allowsSuperAdmin := false
	for _, role := range allowed {
		if domain.IsSuperAdminRole(role) {
			allowsSuperAdmin = true
			break
		}
	}
	return func(c *gin.Context) {
		id, ok := deliveryhttp.IdentityFrom(c)
		if !ok {
			response.Fail(c, domain.ErrUnauthorized)
			c.Abort()
			return
		}
		for _, role := range allowed {
			if id.Role == role {
				c.Next()
				return
			}
		}
		if allowsSuperAdmin && id.Role == domain.RoleDevSuperAdmin {
			c.Next()
			return
		}
		response.Fail(c, domain.ErrForbiddenBranch)
		c.Abort()
	}
}

// RequireSuperAdmin is the chain helper for super-admin routes: it admits
// super_admin and the hidden dev-superadmin, and refuses every other role
// (vendor included). Route groups mount this instead of naming both roles.
func RequireSuperAdmin() gin.HandlerFunc {
	return RequireRoles(domain.RoleSuperAdmin, domain.RoleDevSuperAdmin)
}

// CheckBranch enforces multi-branch isolation for one target branch:
// super_admin passes everywhere (national bypass), while every other role
// must carry exactly the branch it touches. A branch-locked caller without a
// location is refused rather than treated as global. The refusal is the
// ErrForbiddenBranch sentinel itself, so domain.FromError renders the
// mandated 403 with the exact message.
func CheckBranch(id deliveryhttp.Identity, target domain.UUID) error {
	if domain.IsSuperAdminRole(id.Role) {
		return nil
	}
	if id.LocationID == nil || *id.LocationID != target {
		return domain.ErrForbiddenBranch
	}
	return nil
}

// EffectiveScope resolves the location filter a listing endpoint must apply:
// super_admin may pass nil (every branch) or narrow to ?location_id=, while
// admin and security are locked to their own branch and vendor is refused.
// An unparseable filter can never widen the scope, so it fails closed.
//
// Listing reads stay scalar in this wave: the stashed thc.scope union widens
// the write and single-read guards only (CheckBranchFor, requireBranchAccess,
// authorizeBranch, canReadAvatar). Flipping the listing queries to the union
// waits for the dual-write that backfills user_locations.
func EffectiveScope(id deliveryhttp.Identity, queryLocation string) (*domain.UUID, error) {
	if domain.IsSuperAdminRole(id.Role) {
		if queryLocation == "" {
			return nil, nil
		}
		locationID := domain.UUID(queryLocation)
		return &locationID, nil
	}
	if id.Role != domain.RoleAdmin && id.Role != domain.RoleSecurity {
		return nil, domain.ErrForbiddenBranch
	}
	if id.LocationID == nil {
		return nil, domain.ErrForbiddenBranch
	}
	return id.LocationID, nil
}
