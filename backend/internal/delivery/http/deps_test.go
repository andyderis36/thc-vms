package http

import (
	"net/http"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func wired() gin.HandlerFunc {
	return func(c *gin.Context) { c.Status(http.StatusOK) }
}

// fullyWiredDeps builds a Deps whose every route member is bound, so a
// failing check can only come from a member that was actually left out.
func fullyWiredDeps() Deps {
	auth := AuthRoutes{Login: wired(), Me: wired(), Logout: wired()}
	users := UserRoutes{List: wired(), Create: wired(), UpdateStatus: wired(), Update: wired(), Delete: wired()}
	super := SuperAdminRoutes{
		CreateLocation: wired(), UpdateLocation: wired(), DeleteLocation: wired(),
		ListUsers: wired(), CreateUser: wired(), UpdateUser: wired(),
		UpdateUserStatus: wired(), DeleteUser: wired(), DeleteVisit: wired(),
	}
	master := MasterRoutes{Locations: wired(), Purposes: wired(), Vendors: wired()}
	visits := VisitRoutes{
		List: wired(), Create: wired(), Get: wired(), QR: wired(),
		Reschedule: wired(), Cancel: wired(), Approve: wired(), Reject: wired(),
		Jabatan: wired(),
	}
	gate := GateRoutes{CheckIn: wired(), CheckOut: wired()}
	upload := UploadRoutes{Upload: wired()}
	file := FileRoutes{File: wired()}
	audit := AuditRoutes{List: wired()}
	notifications := NotificationRoutes{List: wired(), MarkRead: wired(), MarkAllRead: wired()}
	health := HealthProbes{Health: wired(), Ready: wired()}
	chain := Chain{
		Recovery: wired(), CORS: wired(), LoginLimiter: wired(),
		Authenticate: wired(), AdminOnly: wired(), ApproveOnly: wired(),
		GateOnly: wired(), SuperAdminOnly: wired(), NotifyOnly: wired(),
	}
	return Deps{
		Auth: auth, Users: users, SuperAdmin: super, Master: master,
		Visits: visits, Gate: gate, Upload: upload, File: file,
		Audit: audit, Notifications: notifications, Health: health, Chain: chain,
	}
}

func TestValidateDepsAcceptsFullyWiredDeps(t *testing.T) {
	if err := ValidateDeps(fullyWiredDeps()); err != nil {
		t.Fatalf("fully wired deps must validate, got: %v", err)
	}
}

// The super_admin account update route is the one that was left unwired in
// production: it mounted as a pass-through and answered 200 with an empty
// body, so the name change reported success but never reached the database.
func TestValidateDepsReportsUnwiredManagedUserUpdate(t *testing.T) {
	deps := fullyWiredDeps()
	deps.SuperAdmin.UpdateUser = nil

	err := ValidateDeps(deps)
	if err == nil {
		t.Fatal("an unwired managed-user update handler must fail the wiring check")
	}
	if !strings.Contains(err.Error(), "UpdateUser") {
		t.Fatalf("the error must name the missing member, got: %v", err)
	}
	if !strings.Contains(err.Error(), "superadmin") {
		t.Fatalf("the error must name the route group, got: %v", err)
	}
}

func TestValidateDepsReportsUnwiredChainMiddleware(t *testing.T) {
	deps := fullyWiredDeps()
	deps.Chain.SuperAdminOnly = nil

	err := ValidateDeps(deps)
	if err == nil {
		t.Fatal("an unwired authorization middleware must fail the wiring check")
	}
	if !strings.Contains(err.Error(), "SuperAdminOnly") {
		t.Fatalf("the error must name the missing member, got: %v", err)
	}
}

// The local dev open mode (AUTH_RATE_LIMIT=-1) leaves the login limiter out
// on purpose, so it must not trip the wiring check.
func TestValidateDepsAllowsUnwiredLoginLimiter(t *testing.T) {
	deps := fullyWiredDeps()
	deps.Chain.LoginLimiter = nil

	if err := ValidateDeps(deps); err != nil {
		t.Fatalf("the login limiter is optional, got: %v", err)
	}
}
