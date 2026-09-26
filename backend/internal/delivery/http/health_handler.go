package http

import (
	"context"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/response"
)

// Pinger answers whether the database can serve traffic. *pgxpool.Pool
// satisfies it, so production passes the pool and tests pass a fake or nil.
type Pinger interface {
	Ping(ctx context.Context) error
}

// readyTimeout bounds the readiness ping so a wedged pool fails the probe
// loudly instead of hanging it.
const readyTimeout = 2 * time.Second

// HealthHandler serves the unauthenticated liveness and readiness probes:
// GET /health and GET /ready per docs/4. openapi.yaml.
type HealthHandler struct {
	ping    Pinger
	started time.Time
}

// NewHealthHandler wires the probes. A nil pinger is allowed: /health never
// touches the database, and /ready answers 503 until a real pool is wired.
func NewHealthHandler(ping Pinger) *HealthHandler {
	return &HealthHandler{ping: ping, started: time.Now()}
}

// healthData mirrors the openapi HealthResponse data object exactly: status,
// uptime and timestamp.
type healthData struct {
	Status    string `json:"status"`
	Uptime    string `json:"uptime"`
	Timestamp string `json:"timestamp"`
}

// Health serves GET /health with 200 {status: healthy, uptime, timestamp}.
// It needs no auth and never pings the database.
func (h *HealthHandler) Health(c *gin.Context) {
	response.OK(c, h.payload("healthy"))
}

// Ready serves GET /ready with 200 when the pool answers a ping and 503
// through the failure envelope when it does not. It needs no auth.
func (h *HealthHandler) Ready(c *gin.Context) {
	if h.ping == nil {
		response.FailWith(c, http.StatusServiceUnavailable, "NOT_READY", "Database belum siap melayani request.")
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), readyTimeout)
	defer cancel()
	if err := h.ping.Ping(ctx); err != nil {
		response.FailWith(c, http.StatusServiceUnavailable, "NOT_READY", "Database belum siap melayani request.")
		return
	}
	response.OK(c, h.payload("ready"))
}

// payload stamps one probe body with the current uptime and timestamp.
func (h *HealthHandler) payload(status string) healthData {
	return healthData{
		Status:    status,
		Uptime:    time.Since(h.started).Round(time.Second).String(),
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	}
}
