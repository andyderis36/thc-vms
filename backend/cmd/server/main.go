// Command server boots the THC-VMS backend: configuration, pool, embedded
// migrations (APP_ENV=local only), object-storage bucket, usecases, handlers,
// the /api/v1 route table, the in-process auto-rule worker, and the HTTP
// server with graceful shutdown on SIGINT/SIGTERM.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/config"
	deliveryhttp "thc-vms/backend/internal/delivery/http"
	"thc-vms/backend/internal/delivery/http/handlers"
	"thc-vms/backend/internal/delivery/http/middleware"
	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/infrastructure/directory"
	"thc-vms/backend/internal/infrastructure/emailchange"
	infraJWT "thc-vms/backend/internal/infrastructure/jwt"
	"thc-vms/backend/internal/infrastructure/migrate"
	"thc-vms/backend/internal/infrastructure/storage"
	"thc-vms/backend/internal/repository"
	"thc-vms/backend/internal/usecase/auth"
	"thc-vms/backend/internal/usecase/avatar"
	"thc-vms/backend/internal/usecase/gate"
	"thc-vms/backend/internal/usecase/notification"
	"thc-vms/backend/internal/usecase/visit"
	"thc-vms/backend/internal/validation"
	"thc-vms/backend/internal/worker"
)

// timeouts for the HTTP server and the graceful shutdown.
const (
	// Uploads ingest up to 20 MB (MAX_UPLOAD_INGEST_MB). A 10s read deadline
	// truncates multipart bodies on slow links and surfaces as a misleading
	// 400 "Isi multipart tidak valid."; keep ReadHeaderTimeout short instead.
	readTimeout     = 120 * time.Second
	readHeader      = 5 * time.Second
	writeTimeout    = 120 * time.Second
	idleTimeout     = 60 * time.Second
	shutdownTimeout = 10 * time.Second
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := run(ctx); err != nil {
		slog.Error("thc-vms backend failed", "err", err)
		os.Exit(1)
	}
}

// run executes the ordered startup. Any failure returns an error for main to
// log and exit non-zero; run itself never panics and never calls os.Exit.
func run(ctx context.Context) error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("load configuration: %w", err)
	}
	slog.Info("starting thc-vms backend",
		"app", cfg.App.Name, "env", cfg.App.Environment, "port", cfg.App.Port)

	slog.Info("connecting to database", "host", cfg.DB.Host, "port", cfg.DB.Port, "db", cfg.DB.Name)
	pool, err := repository.NewPool(ctx, cfg)
	if err != nil {
		return fmt.Errorf("open database pool: %w", err)
	}
	defer pool.Close()
	slog.Info("database pool ready")

	if cfg.App.Environment == "local" {
		slog.Info("running embedded database migrations")
		if err := migrate.Up(ctx, cfg.DB.DSN()); err != nil {
			return fmt.Errorf("apply embedded migrations: %w", err)
		}
		slog.Info("database migrations complete")
	} else {
		slog.Info("skipping embedded migrations", "env", cfg.App.Environment)
	}

	store, err := storage.NewMinIOAdapter(cfg)
	if err != nil {
		return fmt.Errorf("build storage adapter: %w", err)
	}
	slog.Info("ensuring object storage bucket")
	if err := store.EnsureBucket(ctx); err != nil {
		return fmt.Errorf("ensure object storage bucket: %w", err)
	}
	slog.Info("object storage bucket ready")

	// The mailer is OPTIONAL (nil when SMTP_ENABLED=false, the default): a
	// nil port only disables email fan-out, it never fails a write.
	// Construction performs no network I/O, so boot stays instant offline;
	// a half-configured enabled mailer fails fast here via the adapter.
	smtpMailer, err := buildMailer(cfg)
	if err != nil {
		return fmt.Errorf("build mailer: %w", err)
	}
	logMailerStatus(cfg)
	mailPort := mailerPort(smtpMailer)

	clock := domain.SystemClock{}
	logger := slog.Default()
	users := repository.NewUserRepository(pool)
	visits := repository.NewVisitRepository(pool).WithMailer(mailPort)
	master := repository.NewMasterDataRepository(pool)
	checkins := repository.NewCheckInOutRepository(pool)
	autorules := repository.NewVisitAutoRuleRepository(pool)
	audit := repository.NewAuditRepository(pool)
	notifications := repository.NewNotificationRepository(pool)
	// vendorNotices anchors the vendor-registration queue (migration 000020):
	// the same adapter serves the register fan-out (authSvc Notices), the
	// superadmin directory serves the mail leg (authSvc SuperAdmins), and
	// the pending-registrations feed below.
	vendorNotices := repository.NewVendorRegistrationNoticeRepository(pool)

	dir := directory.New(pool, master)
	jwtSvc := infraJWT.NewService(cfg).WithDirectory(dir)
	// File links on visit reads are short-lived presigned URLs of our own
	// private bucket (never the raw stored address); the TTL comes from
	// S3_PRESIGN_TTL_MINUTES and is guaranteed positive by config. The object
	// reader powers the scoped GET /visits/:id/file stream (bytes, not links).
	notificationSvc := notification.NewService(notifications)
	// The uploaded-file URL allowlist must accept the URLs this deployment's
	// own object storage hands out. On a LAN install without TLS the public
	// base is a plain-http IP (Caddy same-origin /s3 path), so the trusted
	// hosts are derived from the very config the storage adapter reads.
	fileOrigins := visit.NewFileOriginAllowlist(cfg.Storage.PublicBaseURL, cfg.Storage.Endpoint)
	visitSvc := visit.NewService(visits, master, clock, checkins, repository.NewVendorRepository(pool)).
		WithFileLinks(store, cfg.Storage.PresignTTL()).
		WithObjectReader(store).
		WithTrustedFileOrigins(fileOrigins).
		WithMailer(mailPort)
	gateSvc := gate.NewService(gate.Dependencies{
		Visits: visits, CheckIns: checkins, Clock: clock, Logger: logger,
		TrustedFileOrigins: fileOrigins,
		Mailer:             mailPort,
	})
	workerSvc := worker.NewService(worker.Dependencies{
		Visits: visits, Rules: autorules, CheckIns: checkins, Notifications: notifications, Clock: clock, Logger: logger,
		Mailer: mailPort,
	})

	securityRoleID, err := dir.RoleIDByName(ctx, domain.RoleSecurity)
	if err != nil {
		return fmt.Errorf("resolve security role id: %w", err)
	}
	slog.Info("security role resolved")

	// The super_admin back-office (PRD §4) creates admin/vendor accounts, so
	// their role rows are resolved once at startup like the security role.
	adminRoleID, err := dir.RoleIDByName(ctx, domain.RoleAdmin)
	if err != nil {
		return fmt.Errorf("resolve admin role id: %w", err)
	}
	vendorRoleID, err := dir.RoleIDByName(ctx, domain.RoleVendor)
	if err != nil {
		return fmt.Errorf("resolve vendor role id: %w", err)
	}
	slog.Info("admin and vendor roles resolved")

	// One managed-account adapter serves both the public vendor
	// self-registration (POST /auth/register, status inactive) and the
	// superadmin back office below.
	managedUsers := repository.NewManagedUserRepository(pool)
	authSvc := auth.NewService(auth.Deps{
		Users: users, Roles: dir.Roles(), Locations: master, Vendors: repository.NewVendorRepository(pool), Issuer: jwtSvc, Clock: clock,
		Profiles: repository.NewProfileRepository(pool), Audit: audit,
		// Storage backs the avatar ownership proof on PATCH /auth/me; avatar
		// reads no longer presign, they stream through GET /avatars/:id.
		Storage: store,
		// ManagedUserRepository backs POST /auth/register (vendor
		// self-registration with status inactive).
		Managed:      managedUsers,
		VendorRoleID: vendorRoleID,
		// The email-change notices ride the existing mail port (nil when SMTP
		// is disabled: notices skip, the token still returns); the tokens are
		// minted by the infrastructure HS256 service over the existing JWT
		// secret (no new key material). The verification link points back at
		// the public web origin so the holder lands on /verify-email.
		Mailer:          mailPort,
		EmailTokens:     emailChangeTokenAdapter{tokens: emailchange.NewService(cfg.JWT.Secret)},
		FrontendBaseURL: cfg.App.FrontendBaseURL,
		// The vendor-registration fan-out writes one durable queue row per
		// self-registration (nil would silently drop it) and mails the
		// active superadmin set (nil mailer or directory only skips mail,
		// the row and the 201 still stand).
		Notices:     vendorNotices,
		SuperAdmins: repository.NewSuperAdminDirectoryRepository(pool),
	})
	slog.Info("auth service wired")

	authHandler := handlers.NewAuthHandler(authSvc)
	emailChangeHandler := handlers.NewEmailChangeHandler(authSvc,
		middleware.NewEmailChangeRateLimiter(middleware.DefaultEmailChangeLimits()))
	visitHandler := handlers.NewVisitHandler(visitSvc)
	gateHandler := handlers.NewGateHandler(gateSvc)
	masterHandler := handlers.NewMasterHandler(master)
	userHandler := handlers.NewUserHandler(users, master, securityRoleID)
	superAdminHandler := handlers.NewSuperAdminHandler(
		managedUsers,
		repository.NewLocationAdminRepository(pool),
		repository.NewPurposeAdminRepository(pool),
		visits,
		adminRoleID, vendorRoleID,
		// Delete paths collect stored keys before the row goes and purge the
		// objects best-effort after the commit (row-first, object-second).
		// Approving or rejecting a pending vendor also drains its
		// registration queue row (best-effort, never fails the flip).
	).WithStorage(store).WithCheckIns(checkins).WithMailer(mailPort).WithRegistrationResolver(authSvc)
	avatarSvc := avatar.NewService(avatar.Deps{Users: users, Objects: store})
	avatarHandler := handlers.NewAvatarHandler(avatarSvc)
	uploadHandler := handlers.NewUploadHandler(store, cfg.Upload.MaxIngestBytes)
	fileHandler := handlers.NewFileHandler(visitSvc)
	auditHandler := handlers.NewAuditHandler(audit)
	notificationHandler := handlers.NewNotificationHandler(notificationSvc)
	// The pending-registration feed reads the same queue the register fan-out
	// writes, so a self-registration shows up on the next superadmin poll.
	pendingRegistrationHandler := handlers.NewPendingRegistrationHandler(vendorNotices)
	healthHandler := deliveryhttp.NewHealthHandler(pool)

	// The anti-bruteforce limit is a deployment choice, not a spec constant: the
	// PRD mandates the component but sets no threshold. It is therefore
	// env-driven with the documented local default, so a QA run or a stricter
	// production posture can change it without a rebuild.
	//
	// Sentinel "-1" disables the limiter entirely (local dev/QA open mode):
	// nil makes the router fall back to passthrough, so no per-IP tracking
	// happens at all. It is read raw via os.Getenv because envInt only
	// accepts positive integers and would fall back to 5 on -1.
	// Production keeps the default 5 attempts per minute.
	var loginLimiter gin.HandlerFunc
	if os.Getenv("AUTH_RATE_LIMIT") != "-1" {
		loginLimiter = middleware.NewRateLimiter(
			envInt("AUTH_RATE_LIMIT", middleware.DefaultAuthRateLimit),
			envDuration("AUTH_RATE_WINDOW", middleware.DefaultAuthRateWindow),
		).Middleware()
	} else {
		slog.Warn("auth rate limiter disabled (AUTH_RATE_LIMIT=-1): local dev open mode")
	}
	// Public self-registration carries its own throttle (5/hour per IP plus
	// 3/24h per target email with a best-effort audit row on every hit), so
	// POST /auth/register mounts this instead of the shared login limiter.
	// The open-mode sentinel disables it together with the login limiter.
	var registerLimiter gin.HandlerFunc
	if os.Getenv("AUTH_RATE_LIMIT") != "-1" {
		registerLimiter = middleware.NewRegisterRateLimiter(middleware.DefaultRegisterLimits(), audit).Middleware()
	} else {
		slog.Warn("register rate limiter disabled (AUTH_RATE_LIMIT=-1): local dev open mode")
	}
	// Mode Gin mengikuti env: production (atau APP_DEBUG=false) berjalan
	// dengan gin.ReleaseMode agar tidak membocorkan stack trace debug.
	// Dev default (APP_ENV=local, APP_DEBUG=true) tetap gin.DebugMode.
	if cfg.App.Environment == "production" || !cfg.App.Debug {
		gin.SetMode(gin.ReleaseMode)
	}
	deps := deliveryhttp.Deps{
		Auth: deliveryhttp.AuthRoutes{
			Login: authHandler.Login, Register: authHandler.Register, Me: authHandler.Me, PatchMe: authHandler.PatchMe,
			Logout:             authHandler.Logout,
			RequestEmailChange: emailChangeHandler.RequestEmailChange, ConfirmEmailChange: emailChangeHandler.ConfirmEmailChange,
		},
		Users: deliveryhttp.UserRoutes{
			List: userHandler.ListSecurity, Create: userHandler.CreateSecurity,
			UpdateStatus: userHandler.UpdateSecurityStatus, Delete: userHandler.DeleteSecurity,
			Update: userHandler.UpdateSecurity,
		},
		SuperAdmin: superAdminRoutes(superAdminHandler),
		Master: deliveryhttp.MasterRoutes{
			Locations: masterHandler.ListLocations, Purposes: masterHandler.ListPurposes,
			Vendors: masterHandler.ListVendors,
		},
		Visits: deliveryhttp.VisitRoutes{
			List: visitHandler.List, Create: visitHandler.Create, Get: visitHandler.Get,
			QR: visitHandler.QR, Reschedule: visitHandler.Reschedule, Cancel: visitHandler.Cancel,
			Approve: visitHandler.Approve, Reject: visitHandler.Reject,
			Jabatan: visitHandler.ListJabatan,
		},
		Gate: deliveryhttp.GateRoutes{
			CheckIn: gateHandler.CheckIn, CheckOut: gateHandler.CheckOut,
		},
		Upload: deliveryhttp.UploadRoutes{Upload: uploadHandler.Upload},
		File:   deliveryhttp.FileRoutes{File: fileHandler.File},
		Avatar: deliveryhttp.AvatarRoutes{Avatar: avatarHandler.Avatar},
		Audit:  deliveryhttp.AuditRoutes{List: auditHandler.List},
		Notifications: deliveryhttp.NotificationRoutes{
			List:                 notificationHandler.List,
			MarkRead:             notificationHandler.MarkRead,
			MarkAllRead:          notificationHandler.MarkAllRead,
			PendingRegistrations: pendingRegistrationHandler.List,
		},
		Health: deliveryhttp.HealthProbes{Health: healthHandler.Health, Ready: healthHandler.Ready},
		Chain: deliveryhttp.Chain{
			Recovery: middleware.Recovery(),
			// Asal tunnel Cloudflare (mis. https://xxx.trycloudflare.com) didaftarkan
			// lewat CORS_ALLOWED_ORIGINS (koma-dipisah di backend/.env); kosong =
			// default lokal middleware (localhost:3210).
			CORS:         middleware.CORS(envList("CORS_ALLOWED_ORIGINS")...),
			BodyLimit:    middleware.BodyLimit(validation.JSONBodyMaxBytes, deliveryhttp.UploadPath),
			LoginLimiter: loginLimiter,
			RegisterLimiter: registerLimiter,
			Authenticate: middleware.JWT(jwtSvc, authSvc),
			AdminOnly: middleware.RequireRoles(
				domain.RoleSuperAdmin, domain.RoleDevSuperAdmin, domain.RoleAdmin),
			SuperAdminOnly: middleware.RequireSuperAdmin(),
			ApproveOnly: middleware.RequireRoles(
				domain.RoleSuperAdmin, domain.RoleDevSuperAdmin, domain.RoleAdmin),
			GateOnly: middleware.RequireRoles(
				domain.RoleSecurity, domain.RoleAdmin, domain.RoleSuperAdmin, domain.RoleDevSuperAdmin),
			NotifyOnly: middleware.RequireRoles(
				domain.RoleSuperAdmin, domain.RoleDevSuperAdmin, domain.RoleAdmin, domain.RoleSecurity, domain.RoleVendor),
		},
	}
	// A nil route member mounts as a pass-through, so a handler forgotten here
	// would answer 200 with an empty body and silently drop the write.
	if err := deliveryhttp.ValidateDeps(deps); err != nil {
		return fmt.Errorf("route wiring: %w", err)
	}
	engine := deliveryhttp.New(deps)

	interval := worker.IntervalFromEnv()
	if interval > worker.ReminderWindow {
		slog.Warn("worker interval exceeds reminder window: some pre-visit reminders may be missed",
			"interval", interval.String(), "reminder_window", worker.ReminderWindow.String())
	}
	runner := worker.NewRunner(workerSvc, interval, logger)
	workerDone := make(chan struct{})
	go func() {
		defer close(workerDone)
		runner.Start(ctx)
	}()
	slog.Info("starting background auto-rule worker", "interval", interval.String())

	// Reaper Wave-2: nightly sweep of orphaned objects under the four
	// <dir>/pending/ prefixes. REAPER_DRY_RUN defaults ON, so a fresh
	// deploy only logs what it WOULD delete; REAPER_GRACE_HOURS defaults
	// to 24h. The repository's pg_try_advisory_lock slot keeps replicas
	// from racing on the same objects.
	reaperConfig := worker.ReaperConfigFromEnv()
	reaper := worker.NewReaper(worker.ReaperDeps{
		Store:    store,
		Repo:     repository.NewReaperRepository(pool),
		Config:   reaperConfig,
		Interval: worker.ReaperIntervalFromEnv(),
		Clock:    clock,
		Logger:   logger,
	})
	reaperDone := make(chan struct{})
	go func() {
		defer close(reaperDone)
		reaper.Start(ctx)
	}()
	slog.Info("starting background pending-orphan reaper",
		"interval", reaper.Interval().String(),
		"grace", reaperConfig.Grace.String(),
		"dry_run", reaperConfig.DryRun)

	addr := ":" + strconv.Itoa(cfg.App.Port)
	server := &http.Server{
		Addr:              addr,
		Handler:           engine,
		ReadTimeout:       readTimeout,
		ReadHeaderTimeout: readHeader,
		WriteTimeout:      writeTimeout,
		IdleTimeout:       idleTimeout,
	}
	serverErr := make(chan error, 1)
	go func() {
		slog.Info("http server listening", "addr", addr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErr <- err
			return
		}
		close(serverErr)
	}()

	select {
	case <-ctx.Done():
		slog.Info("shutdown signal received")
	case err := <-serverErr:
		if err != nil {
			return fmt.Errorf("http server failed: %w", err)
		}
		return errors.New("http server stopped unexpectedly")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("graceful http shutdown: %w", err)
	}
	slog.Info("http server stopped")
	<-workerDone
	slog.Info("background worker stopped")
	<-reaperDone
	slog.Info("background reaper stopped")
	// Drain the mail queue after the workers stop so notifications enqueued
	// by the last sweeps still flush; a nil mailer is a no-op. The drain is
	// bounded inside the adapter, so shutdown cannot hang here.
	if err := closeMailer(smtpMailer); err != nil {
		slog.Warn("mailer drain failed", "err", err)
	} else {
		slog.Info("mailer drained")
	}
	slog.Info("database pool closed")
	slog.Info("shutdown complete")
	return nil
}

// emailChangeTokenAdapter bridges the infrastructure HS256 email-change
// token service to the auth usecase port. Mint maps one-to-one; Verify
// projects the infrastructure claims onto the usecase claims.
type emailChangeTokenAdapter struct {
	tokens *emailchange.Service
}

func (a emailChangeTokenAdapter) Mint(userID domain.UUID, oldEmail, newEmail string) (string, error) {
	return a.tokens.Mint(userID, oldEmail, newEmail)
}

func (a emailChangeTokenAdapter) Verify(token string) (auth.EmailChangeClaims, error) {
	claims, err := a.tokens.Verify(token)
	if err != nil {
		return auth.EmailChangeClaims{}, err
	}
	return auth.EmailChangeClaims{UserID: claims.UserID, OldEmail: claims.OldEmail, NewEmail: claims.NewEmail}, nil
}

// superAdminRoutes binds the super_admin back-office handlers. It lives in
// its own function so a test can assert that no member is left unwired: a nil
// member mounts as a pass-through and would answer 200 with an empty body.
func superAdminRoutes(h *handlers.SuperAdminHandler) deliveryhttp.SuperAdminRoutes {
	return deliveryhttp.SuperAdminRoutes{
		CreateLocation:   h.CreateLocation,
		UpdateLocation:   h.UpdateLocation,
		DeleteLocation:   h.DeleteLocation,
		CreatePurpose:    h.CreatePurpose,
		UpdatePurpose:    h.UpdatePurpose,
		DeletePurpose:    h.DeletePurpose,
		ListUsers:        h.ListUsers,
		CreateUser:       h.CreateUser,
		UpdateUser:       h.UpdateUser,
		UpdateUserStatus: h.UpdateUserStatus,
		DeleteUser:       h.DeleteUser,
		DeleteVisit:      h.DeleteVisit,
	}
}
