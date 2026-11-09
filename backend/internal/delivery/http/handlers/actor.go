// Package handlers maps HTTP onto the visit and gate usecases. Every handler
// answers through response.OK / Created / Fail so the wire shape always stays
// {"success":true,"data":...} or {"success":false,"error":{...}}; no handler
// invents an envelope, a status rule or a storage layout of its own.
package handlers

import (
	"fmt"

	"github.com/gin-gonic/gin"

	deliveryhttp "thc-vms/backend/internal/delivery/http"
	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/avatar"
	"thc-vms/backend/internal/usecase/gate"
	"thc-vms/backend/internal/usecase/visit"
)

// Gin-context identity keys. The middleware (written concurrently by another
// agent) stores the authenticated caller under these keys; identity.go, when
// it lands, is the canonical reader. This file is a THIN local adapter only:
// it reads the same documented keys and converts to the two usecase Actor
// types, which are deliberately SEPARATE (visit.Actor vs gate.Actor).
const (
	// CtxUserID carries the caller's uuid string.
	CtxUserID = "user_id"
	// CtxUserRole carries the caller's role name (super_admin, admin, security, vendor).
	CtxUserRole = "user_role"
	// CtxLocationID carries the caller's branch uuid string; absent for
	// super_admin and vendor.
	CtxLocationID = "location_id"
)

// actorIdentity is the raw identity read from the gin context before it is
// converted into either usecase Actor type.
type actorIdentity struct {
	id         domain.UUID
	role       domain.RoleName
	locationID *domain.UUID
}

// identityFromContext reads the middleware-written keys. A missing id or role
// fails closed as 401: an unauthenticated caller must never reach a usecase.
func identityFromContext(c *gin.Context) (actorIdentity, error) {
	rawID, ok := c.Get(CtxUserID)
	if !ok {
		return actorIdentity{}, fmt.Errorf("handlers: missing %s: %w", CtxUserID, domain.ErrUnauthorized)
	}
	id, ok := rawID.(string)
	if !ok || id == "" {
		if uuid, isUUID := rawID.(domain.UUID); isUUID && uuid != "" {
			id = string(uuid)
		} else {
			return actorIdentity{}, fmt.Errorf("handlers: invalid %s: %w", CtxUserID, domain.ErrUnauthorized)
		}
	}
	rawRole, ok := c.Get(CtxUserRole)
	if !ok {
		return actorIdentity{}, fmt.Errorf("handlers: missing %s: %w", CtxUserRole, domain.ErrUnauthorized)
	}
	var role domain.RoleName
	switch r := rawRole.(type) {
	case string:
		role = domain.RoleName(r)
	case domain.RoleName:
		role = r
	default:
		return actorIdentity{}, fmt.Errorf("handlers: invalid %s: %w", CtxUserRole, domain.ErrUnauthorized)
	}
	identity := actorIdentity{id: domain.UUID(id), role: role}
	if rawLoc, ok := c.Get(CtxLocationID); ok {
		switch loc := rawLoc.(type) {
		case string:
			if loc != "" {
				locationID := domain.UUID(loc)
				identity.locationID = &locationID
			}
		case domain.UUID:
			if loc != "" {
				locationID := loc
				identity.locationID = &locationID
			}
		case *domain.UUID:
			identity.locationID = loc
		}
	}
	return identity, nil
}

// visitActor converts the context identity to the visit usecase Actor,
// carrying the stashed branch union alongside the scalar primary.
func visitActor(c *gin.Context) (visit.Actor, error) {
	identity, err := identityFromContext(c)
	if err != nil {
		return visit.Actor{}, err
	}
	actor := visit.Actor{ID: identity.id, Role: identity.role, LocationID: identity.locationID}
	applyScope(&actor.Branches, &actor.IsGlobal, c)
	return actor, nil
}

// gateActor converts the context identity to the gate usecase Actor,
// carrying the stashed branch union alongside the scalar primary.
func gateActor(c *gin.Context) (gate.Actor, error) {
	identity, err := identityFromContext(c)
	if err != nil {
		return gate.Actor{}, err
	}
	actor := gate.Actor{ID: identity.id, Role: identity.role, LocationID: identity.locationID}
	applyScope(&actor.Branches, &actor.IsGlobal, c)
	return actor, nil
}

// avatarActor converts the context identity to the avatar usecase Actor,
// carrying the stashed branch union alongside the scalar primary.
func avatarActor(c *gin.Context) (avatar.Actor, error) {
	identity, err := identityFromContext(c)
	if err != nil {
		return avatar.Actor{}, err
	}
	actor := avatar.Actor{ID: identity.id, Role: identity.role, LocationID: identity.locationID}
	applyScope(&actor.Branches, &actor.IsGlobal, c)
	return actor, nil
}

// applyScope copies the stashed thc.scope union onto the actor under
// construction. Without a stash (unwired store, token-free test doubles) the
// actor keeps its zero scope and the usecase guards fall back to the scalar
// rule, so reads and writes decide exactly as before.
func applyScope(branches *[]domain.UUID, isGlobal *bool, c *gin.Context) {
	scope, ok := deliveryhttp.ScopeFrom(c)
	if !ok {
		return
	}
	*branches = scope.LocationIDs
	*isGlobal = scope.IsGlobal
}
