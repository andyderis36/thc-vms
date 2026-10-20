package main

import (
	"testing"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/handlers"
)

// The super_admin back-office routes are the ones that silently degraded to
// a pass-through when a member was left unwired: the route still answered
// 200 with an empty body, so the write never reached the database.
func TestSuperAdminRoutesAreFullyWired(t *testing.T) {
	var handler *handlers.SuperAdminHandler
	routes := superAdminRoutes(handler)

	members := map[string]gin.HandlerFunc{
		"CreateLocation":   routes.CreateLocation,
		"UpdateLocation":   routes.UpdateLocation,
		"DeleteLocation":   routes.DeleteLocation,
		"ListUsers":        routes.ListUsers,
		"CreateUser":       routes.CreateUser,
		"UpdateUser":       routes.UpdateUser,
		"UpdateUserStatus": routes.UpdateUserStatus,
		"DeleteUser":       routes.DeleteUser,
		"DeleteVisit":      routes.DeleteVisit,
	}
	for name, member := range members {
		if member == nil {
			t.Errorf("super_admin route %s is not wired", name)
		}
	}
}
