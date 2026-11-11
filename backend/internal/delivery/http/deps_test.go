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
	auth := AuthRoutes{Login: wired(), Register: wired(), Me: wired(), PatchMe: wired(), Logout: wired(), RequestEmailChange: wired(), ConfirmEmailChange: wired()}
	users := UserRoutes{List: wired(), Create: wired(), UpdateStatus: wired(), Update: wired(), Delete: wired()}
	super := SuperAdminRoutes{
		CreateLocation: wired(), UpdateLocation: wired(), DeleteLocation: wired(),
		CreatePurpose: wired(), UpdatePurpose: wired(), DeletePurpose: wired(),
		ListUsers: wired(), CreateUser: wired(), UpdateUser: wired(),
		UpdateUserStatus: wired(), DeleteUser: wired(), DeleteVisit: wired(),
		ListVendorAccounts: wired(),
	}
	master := MasterRoutes{Locations: wired(), Purposes: wired(), Vendors: wired(), PublicVendors: wired()}
	visits := VisitRoutes{
		List: wired(), Create: wired(), Get: wired(), QR: wired(),
		Reschedule: wired(), Cancel: wired(), Approve: wired(), Reject: wired(),
		UpdateVisitorContact: wired(),
		AttachWorkPhoto:      wired(),
		Jabatan:              wired(),
		VendorSuggestions:    wired(),
		MemberSuggestions:    wired(),
		MemberSuggestion:     wired(),
	}
	gate := GateRoutes{CheckIn: wired(), CheckOut: wired()}
	upload := UploadRoutes{Upload: wired()}
	file := FileRoutes{File: wired()}
	avatar := AvatarRoutes{Avatar: wired()}
	audit := AuditRoutes{List: wired()}
	settings := SettingsRoutes{Get: wired(), Update: wired()}
	notifications := NotificationRoutes{List: wired(), MarkRead: wired(), MarkAllRead: wired(), PendingRegistrations: wired()}
	health := HealthProbes{Health: wired(), Ready: wired()}
	chain := Chain{
		Recovery: wired(), CORS: wired(), BodyLimit: wired(), LoginLimiter: wired(), RegisterLimiter: wired(),
		Authenticate: wired(), AdminOnly: wired(), ApproveOnly: wired(),
		GateOnly: wired(), SuperAdminOnly: wired(), NotifyOnly: wired(),
	}
	return Deps{
		Auth: auth, Users: users, SuperAdmin: super, Master: master,
		Visits: visits, Gate: gate, Upload: upload, File: file,
		Avatar: avatar, Audit: audit, Settings: settings, Notifications: notifications, Health: health, Chain: chain,
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
