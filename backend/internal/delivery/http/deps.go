package http

import (
	"fmt"
	"reflect"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"
)

// handlerType is the exact type of a route member, so the wiring check can
// tell a real handler from any other field of a route struct.
var handlerType = reflect.TypeOf((gin.HandlerFunc)(nil))

// ValidateDeps reports route members that were never wired.
//
// withFallback mounts a nil member as a pass-through, which keeps a route
// registered (never a 404) when a caller mounts only a subset of the API.
// That is the contract the router tests rely on, but it also means a field
// forgotten in the production assembly answers 200 with an empty body and
// silently drops the work instead of failing loudly. Production wiring
// therefore calls ValidateDeps before mounting, so an unwired member aborts
// the boot with the name of the missing handler.
//
// Chain.LoginLimiter and Chain.RegisterLimiter are optional: the local dev
// open mode (AUTH_RATE_LIMIT=-1) deliberately leaves them unset.
func ValidateDeps(d Deps) error {
	groups := []struct {
		name     string
		routes   any
		optional []string
	}{
		{"auth", d.Auth, nil},
		{"users", d.Users, nil},
		{"superadmin", d.SuperAdmin, nil},
		{"master", d.Master, nil},
		{"visits", d.Visits, nil},
		{"gate", d.Gate, nil},
		{"upload", d.Upload, nil},
		{"file", d.File, nil},
		{"avatars", d.Avatar, nil},
		{"audit", d.Audit, nil},
		{"settings", d.Settings, nil},
		{"notifications", d.Notifications, nil},
		{"health", d.Health, nil},
		{"chain", d.Chain, []string{"LoginLimiter", "RegisterLimiter"}},
	}
	for _, group := range groups {
		if err := validateWired(group.name, group.routes, group.optional); err != nil {
			return err
		}
	}
	return nil
}

// validateWired lists the nil handler fields of one route struct.
func validateWired(name string, routes any, optional []string) error {
	skip := make(map[string]struct{}, len(optional))
	for _, member := range optional {
		skip[member] = struct{}{}
	}
	value := reflect.ValueOf(routes)
	routeType := value.Type()
	var missing []string
	for i := 0; i < routeType.NumField(); i++ {
		field := routeType.Field(i)
		if field.Type != handlerType {
			continue
		}
		if _, allowed := skip[field.Name]; allowed {
			continue
		}
		if value.Field(i).IsNil() {
			missing = append(missing, field.Name)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	sort.Strings(missing)
	return fmt.Errorf("%s routes not wired: %s", name, strings.Join(missing, ", "))
}
