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

	"thc-vms/backend/internal/config"
	deliveryhttp "thc-vms/backend/internal/delivery/http"
	"thc-vms/backend/internal/delivery/http/handlers"
	"thc-vms/backend/internal/delivery/http/middleware"
	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/infrastructure/directory"
	infraJWT "thc-vms/backend/internal/infrastructure/jwt"
	"thc-vms/backend/internal/infrastructure/migrate"
	"thc-vms/backend/internal/infrastructure/storage"
	"thc-vms/backend/internal/repository"
	"thc-vms/backend/internal/usecase/auth"
	"thc-vms/backend/internal/usecase/gate"
	"thc-vms/backend/internal/usecase/visit"
	"thc-vms/backend/internal/worker"
)

// timeouts for the HTTP server and the graceful shutdown.
const (
	readTimeout     = 10 * time.Second
	readHeader      = 5 * time.Second
	writeTimeout    = 15 * time.Second
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

	clock := domain.SystemClock{}
	logger := slog.Default()
	users := repository.NewUserRepository(pool)
	visits := repository.NewVisitRepository(pool)
	master := repository.NewMasterDataRepository(pool)
	checkins := repository.NewCheckInOutRepository(pool)
	autorules := repository.NewVisitAutoRuleRepository(pool)

	dir := directory.New(pool, master)
	jwtSvc := infraJWT.NewService(cfg).WithDirectory(dir)
	authSvc := auth.NewService(auth.Deps{
		Users: users, Roles: dir.Roles(), Locations: master, Issuer: jwtSvc, Clock: clock,
	})
	visitSvc := visit.NewService(visits, master, clock)
	gateSvc := gate.NewService(gate.Dependencies{
		Visits: visits, CheckIns: checkins, Clock: clock, Logger: logger,
	})
	workerSvc := worker.NewService(worker.Dependencies{
		Visits: visits, Rules: autorules, CheckIns: checkins, Clock: clock, Logger: logger,
	})

	securityRoleID, err := dir.RoleIDByName(ctx, domain.RoleSecurity)
	if err != nil {
		return fmt.Errorf("resolve security role id: %w", err)
	}
	slog.Info("security role resolved")

	authHandler := handlers.NewAuthHandler(authSvc)
	visitHandler := handlers.NewVisitHandler(visitSvc)
	gateHandler := handlers.NewGateHandler(gateSvc)
	masterHandler := handlers.NewMasterHandler(master)
	userHandler := handlers.NewUserHandler(users, master, securityRoleID)
	uploadHandler := handlers.NewUploadHandler(store, cfg.Upload.MaxSizeBytes)
	healthHandler := deliveryhttp.NewHealthHandler(pool)

	// The anti-bruteforce limit is a deployment choice, not a spec constant: the
	// PRD mandates the component but sets no threshold. It is therefore
	// env-driven with the documented local default, so a QA run or a stricter
	// production posture can change it without a rebuild.
	limiter := middleware.NewRateLimiter(
		envInt("AUTH_RATE_LIMIT", middleware.DefaultAuthRateLimit),
		envDuration("AUTH_RATE_WINDOW", middleware.DefaultAuthRateWindow),
	)
	engine := deliveryhttp.New(deliveryhttp.Deps{
		Auth: deliveryhttp.AuthRoutes{
			Login: authHandler.Login, Me: authHandler.Me, Logout: authHandler.Logout,
		},
		Users: deliveryhttp.UserRoutes{
			List: userHandler.ListSecurity, Create: userHandler.CreateSecurity,
			UpdateStatus: userHandler.UpdateSecurityStatus,
		},
		Master: deliveryhttp.MasterRoutes{
			Locations: masterHandler.ListLocations, Purposes: masterHandler.ListPurposes,
		},
		Visits: deliveryhttp.VisitRoutes{
			List: visitHandler.List, Create: visitHandler.Create, Get: visitHandler.Get,
			QR: visitHandler.QR, Reschedule: visitHandler.Reschedule, Cancel: visitHandler.Cancel,
			Approve: visitHandler.Approve, Reject: visitHandler.Reject,
		},
		Gate: deliveryhttp.GateRoutes{
			CheckIn: gateHandler.CheckIn, CheckOut: gateHandler.CheckOut,
		},
		Upload: deliveryhttp.UploadRoutes{Upload: uploadHandler.Upload},
		Health: deliveryhttp.HealthProbes{Health: healthHandler.Health, Ready: healthHandler.Ready},
		Chain: deliveryhttp.Chain{
			Recovery:     middleware.Recovery(),
			CORS:         middleware.CORS(),
			LoginLimiter: limiter.Middleware(),
			Authenticate: middleware.JWT(jwtSvc, authSvc),
			AdminOnly: middleware.RequireRoles(
				domain.RoleSuperAdmin, domain.RoleAdmin),
			ApproveOnly: middleware.RequireRoles(
				domain.RoleSuperAdmin, domain.RoleAdmin),
			GateOnly: middleware.RequireRoles(
				domain.RoleSecurity, domain.RoleAdmin, domain.RoleSuperAdmin),
		},
	})

	interval := worker.IntervalFromEnv()
	runner := worker.NewRunner(workerSvc, interval, logger)
	workerDone := make(chan struct{})
	go func() {
		defer close(workerDone)
		runner.Start(ctx)
	}()
	slog.Info("starting background auto-rule worker", "interval", interval.String())

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
	slog.Info("database pool closed")
	slog.Info("shutdown complete")
	return nil
}
