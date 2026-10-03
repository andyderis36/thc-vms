// Package http is the shared delivery layer for the Gin handlers and the
// middleware chain (docs/3. Arsitektur Auth: MW1 rate limit -> MW2 JWT ->
// MW3 RBAC/branch scope). It owns the Identity carried in the request
// context. Every handler set - auth, users, master data here and the
// visit/gate/upload handlers a sibling agent writes - reads the caller
// through WithIdentity and IdentityFrom only, so the keys below are the
// single contract between the middleware that authenticates and the handlers
// that authorize.
package http

import (
	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/response"
	"thc-vms/backend/internal/domain"
)

// Canonical context keys. The middleware writes all four through WithIdentity;
// handlers read through IdentityFrom only and never touch c.Get directly.
// The three Ctx* keys stay public so test doubles (and the sibling agent's
// withActor helper) can seed a caller without minting a token; the private
// struct key is the fast path production reads first.
//
// The string values intentionally equal the handlers/actor.go Ctx* constants
// owned by the sibling agent: both readers observe one identical identity no
// matter which writer stored it. Do not change these strings unilaterally;
// that file aliases these constants when both land.
const (
	// CtxUserID carries the authenticated user's id as string or domain.UUID.
	CtxUserID = "user_id"
	// CtxUserRole carries the RBAC role as string or domain.RoleName.
	CtxUserRole = "user_role"
	// CtxLocationID carries the caller's branch as string or domain.UUID.
	// Absent (nil) for super_admin and vendor.
	CtxLocationID = "location_id"
)

// identityStructKey is the private fast-path key holding the whole Identity.
const identityStructKey = "thc.identity"

// Identity is the authenticated caller behind one request: its user id, its
// RBAC role and, for branch-bound roles, its location. super_admin and vendor
// carry a nil LocationID; admin and security must carry their branch.
// Handlers map this into their own usecase actor types (visit.Actor and
// gate.Actor are intentionally separate); this struct is never unified with
// them.
type Identity struct {
	UserID     domain.UUID
	Role       domain.RoleName
	LocationID *domain.UUID
}

// WithIdentity stores the authenticated caller on the gin context. The JWT
// middleware calls this after parsing and re-validating the token. It writes
// both the struct fast path and the three public keys so every read path
// observes one identical identity.
func WithIdentity(c *gin.Context, id Identity) {
	c.Set(identityStructKey, id)
	c.Set(CtxUserID, string(id.UserID))
	c.Set(CtxUserRole, string(id.Role))
	if id.LocationID != nil {
		c.Set(CtxLocationID, string(*id.LocationID))
	}
}

// IdentityFrom returns the caller stored by WithIdentity. The second result
// is false when no middleware stored one, which handlers treat as 401. It
// accepts the struct fast path first, then reassembles the caller from the
// three public keys so token-free test doubles keep working.
func IdentityFrom(c *gin.Context) (Identity, bool) {
	if value, ok := c.Get(identityStructKey); ok {
		if id, ok := value.(Identity); ok {
			return id, true
		}
	}
	userID, ok := stringKey(c, CtxUserID)
	if !ok || userID == "" {
		return Identity{}, false
	}
	role, ok := stringKey(c, CtxUserRole)
	if !ok || role == "" {
		return Identity{}, false
	}
	id := Identity{UserID: domain.UUID(userID), Role: domain.RoleName(role)}
	if loc, ok := stringKey(c, CtxLocationID); ok && loc != "" {
		locationID := domain.UUID(loc)
		id.LocationID = &locationID
	}
	return id, true
}

// RequireIdentity is a gin handler that refuses anonymous requests with the
// 401 envelope. Routes that need authentication without the full JWT parse
// (and tests driving handlers directly) mount this.
func RequireIdentity() gin.HandlerFunc {
	return func(c *gin.Context) {
		if _, ok := IdentityFrom(c); !ok {
			response.Fail(c, domain.ErrUnauthorized)
			c.Abort()
			return
		}
		c.Next()
	}
}

// stringKey reads one public key tolerating the string and named-string
// forms test doubles use.
func stringKey(c *gin.Context, key string) (string, bool) {
	value, ok := c.Get(key)
	if !ok {
		return "", false
	}
	switch v := value.(type) {
	case string:
		return v, true
	case domain.UUID:
		return string(v), true
	case domain.RoleName:
		return string(v), true
	default:
		return "", false
	}
}
