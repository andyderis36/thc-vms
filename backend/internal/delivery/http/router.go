// Package http owns the composition-root route table: every MVP operation
// under /api/v1 and the middleware chain each route mounts. This file is the
// ONLY place routes are registered, so the contract test can prove the
// wiring in one hermetic run.
//
// Handlers and middleware arrive as plain gin.HandlerFunc values through
// Deps: this package cannot import internal/delivery/http/handlers (that
// package reads the Identity this package owns) nor
// internal/delivery/http/middleware (that package writes it), so package
// main passes bound method values such as authHandler.Login and assembled
// chains such as middleware.JWT(...). The table below is still the single
// registration point.
package http

import (
	"github.com/gin-gonic/gin"
)

// AuthRoutes carries the bound auth-handler methods.
type AuthRoutes struct {
	Login  gin.HandlerFunc
	Me     gin.HandlerFunc
	Logout gin.HandlerFunc
}

// UserRoutes carries the bound security-account handler methods.
type UserRoutes struct {
	List         gin.HandlerFunc
	Create       gin.HandlerFunc
	UpdateStatus gin.HandlerFunc
	Update       gin.HandlerFunc
	Delete       gin.HandlerFunc
}

// SuperAdminRoutes carries the bound super_admin back-office methods (PRD
// §4): facility CRUD (including the hard delete), account management
// (including the hard delete) and the visit purge. The fields stay separate
// from UserRoutes/MasterRoutes so a nil member degrades to pass-through in
// tests mounting a subset.
type SuperAdminRoutes struct {
	CreateLocation   gin.HandlerFunc
	UpdateLocation   gin.HandlerFunc
	DeleteLocation   gin.HandlerFunc
	ListUsers        gin.HandlerFunc
	CreateUser       gin.HandlerFunc
	UpdateUserStatus gin.HandlerFunc
	UpdateUser       gin.HandlerFunc
	DeleteUser       gin.HandlerFunc
	DeleteVisit      gin.HandlerFunc
}

// MasterRoutes carries the bound catalogue handler methods.
type MasterRoutes struct {
	Locations gin.HandlerFunc
	Purposes  gin.HandlerFunc
	Vendors   gin.HandlerFunc
}

// VisitRoutes carries the bound visit-lifecycle handler methods.
type VisitRoutes struct {
	List       gin.HandlerFunc
	Create     gin.HandlerFunc
	Get        gin.HandlerFunc
	QR         gin.HandlerFunc
	Reschedule gin.HandlerFunc
	Cancel     gin.HandlerFunc
	Approve    gin.HandlerFunc
	Reject     gin.HandlerFunc
}

// GateRoutes carries the bound gate handler methods.
type GateRoutes struct {
	CheckIn  gin.HandlerFunc
	CheckOut gin.HandlerFunc
}

// UploadRoutes carries the bound upload handler method.
type UploadRoutes struct {
	Upload gin.HandlerFunc
}

// FileRoutes carries the bound scoped file-stream handler method.
type FileRoutes struct {
	File gin.HandlerFunc
}

// AuditRoutes carries the bound audit-trail handler method (super_admin
// only: the trail is the back-office's own history, never branch-scoped).
type AuditRoutes struct {
	List gin.HandlerFunc
}

// NotificationRoutes carries the bound notification handler methods (every
// authenticated role: super_admin, admin, security and vendor).
type NotificationRoutes struct {
	List        gin.HandlerFunc
	MarkRead    gin.HandlerFunc
	MarkAllRead gin.HandlerFunc
}

// Chain is the pre-built middleware for each route group.
type Chain struct {
	Recovery       gin.HandlerFunc
	CORS           gin.HandlerFunc
	LoginLimiter   gin.HandlerFunc
	Authenticate   gin.HandlerFunc
	AdminOnly      gin.HandlerFunc
	ApproveOnly    gin.HandlerFunc
	GateOnly       gin.HandlerFunc
	SuperAdminOnly gin.HandlerFunc
	NotifyOnly     gin.HandlerFunc
}

// HealthProbes carries the bound probe methods.
type HealthProbes struct {
	Health gin.HandlerFunc
	Ready  gin.HandlerFunc
}

// Deps bundles every collaborator the route table needs in one named struct
// so New keeps a single parameter. A nil handler or chain member degrades to
// pass-through so hermetic tests can mount a subset.
type Deps struct {
	Auth          AuthRoutes
	Users         UserRoutes
	SuperAdmin    SuperAdminRoutes
	Master        MasterRoutes
	Visits        VisitRoutes
	Gate          GateRoutes
	Upload        UploadRoutes
	File          FileRoutes
	Audit         AuditRoutes
	Notifications NotificationRoutes
	Health        HealthProbes
	Chain         Chain
}

// passthrough is the nil-member fallback used only by tests mounting a
// subset of the handlers or middleware.
func passthrough(c *gin.Context) {
	c.Next()
}

// withFallback substitutes pass-through for a nil member.
func withFallback(next gin.HandlerFunc) gin.HandlerFunc {
	if next == nil {
		return passthrough
	}
	return next
}

// New builds the Gin engine serving the whole MVP API under /api/v1.
// Unauthenticated: POST /auth/login (behind the rate limiter), GET /health,
// GET /ready. Everything else mounts Authenticate (JWT -> RequireIdentity),
// with AdminOnly narrowing the security-account routes, SuperAdminOnly
// narrowing the back-office facility and account routes to super_admin,
// ApproveOnly narrowing approve/reject to super_admin and admin (a vendor is
// refused there), and GateOnly keeping check-in/out to security, admin and
// super_admin. GET /visits/:id/file streams a stored file slot inline (the
// usecase scopes the branch/owner and answers 404 otherwise). EXPLICITLY NOT
// ROUTED (they 404): POST /visits/:id/feedback, POST /visits/:id/incident,
// SSO/OTP/2FA.
//
// DELETE /locations/:id is the hard removal and is refused with 409 while
// users.location_id or visit_request.location_id still reference the row, so
// operational history is never orphaned by accident. Deactivation via PATCH
// /locations/:id {is_active:false} stays the supported soft removal.
func New(d Deps) *gin.Engine {
	engine := gin.New()
	engine.Use(withFallback(d.Chain.Recovery))
	engine.Use(withFallback(d.Chain.CORS))

	v1 := engine.Group("/api/v1")
	v1.POST("/auth/login", withFallback(d.Chain.LoginLimiter), withFallback(d.Auth.Login))
	v1.GET("/health", withFallback(d.Health.Health))
	v1.GET("/ready", withFallback(d.Health.Ready))

	authed := v1.Group("")
	authed.Use(withFallback(d.Chain.Authenticate))
	authed.GET("/auth/me", withFallback(d.Auth.Me))
	authed.POST("/auth/logout", withFallback(d.Auth.Logout))

	admins := authed.Group("")
	admins.Use(withFallback(d.Chain.AdminOnly))
	admins.GET("/users/security", withFallback(d.Users.List))
	admins.POST("/users/security", withFallback(d.Users.Create))
	admins.PATCH("/users/security/:id/status", withFallback(d.Users.UpdateStatus))
	admins.PATCH("/users/security/:id", withFallback(d.Users.Update))
	admins.DELETE("/users/security/:id", withFallback(d.Users.Delete))
	// Pendaftaran vendor dibuka untuk admin cabang (PRD §4.1; handler menolak
	// non-vendor dari pemanggil admin). Daftar/ubah/hapus user tetap superadmin.
	admins.POST("/users", withFallback(d.SuperAdmin.CreateUser))

	super := authed.Group("")
	super.Use(withFallback(d.Chain.SuperAdminOnly))
	super.POST("/locations", withFallback(d.SuperAdmin.CreateLocation))
	super.PATCH("/locations/:id", withFallback(d.SuperAdmin.UpdateLocation))
	super.DELETE("/locations/:id", withFallback(d.SuperAdmin.DeleteLocation))
	super.GET("/users", withFallback(d.SuperAdmin.ListUsers))
	super.PATCH("/users/:id/status", withFallback(d.SuperAdmin.UpdateUserStatus))
	super.PATCH("/users/:id", withFallback(d.SuperAdmin.UpdateUser))
	super.DELETE("/users/:id", withFallback(d.SuperAdmin.DeleteUser))
	super.DELETE("/visits/:id", withFallback(d.SuperAdmin.DeleteVisit))
	super.GET("/audit-logs", withFallback(d.Audit.List))

	notify := authed.Group("")
	notify.Use(withFallback(d.Chain.NotifyOnly))
	notify.GET("/notifications", withFallback(d.Notifications.List))
	notify.PATCH("/notifications/:id", withFallback(d.Notifications.MarkRead))
	notify.POST("/notifications/read-all", withFallback(d.Notifications.MarkAllRead))

	authed.GET("/locations", withFallback(d.Master.Locations))
	authed.GET("/purposes", withFallback(d.Master.Purposes))
	authed.GET("/vendors", withFallback(d.Master.Vendors))

	authed.GET("/visits", withFallback(d.Visits.List))
	authed.POST("/visits", withFallback(d.Visits.Create))
	authed.GET("/visits/:id", withFallback(d.Visits.Get))
	authed.GET("/visits/:id/file", withFallback(d.File.File))
	authed.GET("/visits/:id/qr", withFallback(d.Visits.QR))
	authed.POST("/visits/:id/reschedule", withFallback(d.Visits.Reschedule))
	authed.POST("/visits/:id/cancel", withFallback(d.Visits.Cancel))

	approvers := authed.Group("")
	approvers.Use(withFallback(d.Chain.ApproveOnly))
	approvers.POST("/visits/:id/approve", withFallback(d.Visits.Approve))
	approvers.POST("/visits/:id/reject", withFallback(d.Visits.Reject))

	gate := authed.Group("")
	gate.Use(withFallback(d.Chain.GateOnly))
	gate.POST("/visits/:id/checkin", withFallback(d.Gate.CheckIn))
	gate.POST("/visits/:id/checkout", withFallback(d.Gate.CheckOut))

	authed.POST("/uploads", withFallback(d.Upload.Upload))

	return engine
}
