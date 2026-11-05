package middleware

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/response"
	"thc-vms/backend/internal/domain"
)

// Public self-registration rate limit thresholds: 5/hour per client IP plus
// 3/24h per target email. These numbers are deployment choices, not PRD
// constants: wire NewRegisterRateLimiter with the values operations wants
// and keep these defaults for local development and tests.
const (
	DefaultRegisterPerIP        = 5
	DefaultRegisterPerTarget    = 3
	DefaultRegisterIPWindow     = time.Hour
	DefaultRegisterTargetWindow = 24 * time.Hour
)

// RegisterRateLimitCode and RegisterRateLimitMessage are the frozen generic
// 429 payload for POST /auth/register. The message stays generic (Bahasa
// Indonesia) and byte-identical to the login and email-change throttles so a
// throttled caller learns nothing about which dimension tripped.
const (
	RegisterRateLimitCode    = "RATE_LIMITED"
	RegisterRateLimitMessage = "Terlalu banyak percobaan. Silakan coba lagi nanti."
)

// RegisterLimits tunes a RegisterRateLimiter. Any non-positive field falls
// back to its DefaultRegister* constant so a zero value can never lock every
// caller out or disable a bucket.
type RegisterLimits struct {
	PerIP        int
	PerTarget    int
	IPWindow     time.Duration
	TargetWindow time.Duration
}

// DefaultRegisterLimits returns the production thresholds above.
func DefaultRegisterLimits() RegisterLimits {
	return RegisterLimits{
		PerIP:        DefaultRegisterPerIP,
		PerTarget:    DefaultRegisterPerTarget,
		IPWindow:     DefaultRegisterIPWindow,
		TargetWindow: DefaultRegisterTargetWindow,
	}
}

// RegisterRateLimiter is the anti-abuse gate for public vendor
// self-registration (POST /auth/register). It composes two fixed-window
// RateLimiter buckets - the same bounded in-memory pruning discipline as
// ratelimit.go and emailchange_ratelimit.go, no Redis - under keys
// register:req:ip:<ip> (5/hour) and register:req:target:<email> (3/24h).
// Every call consults both buckets, so an attempt burns budget on each
// dimension exactly like the email-change limiter does. Only the client IP
// and the target email reach the logs and the audit row; passwords, NIKs and
// phones never do.
type RegisterRateLimiter struct {
	perIP     *RateLimiter
	perTarget *RateLimiter
	audit     domain.AuditRepository
}

// NewRegisterRateLimiter builds the limiter from limits, resolving every
// non-positive field to its default first. A nil audit disables the throttle
// audit row (hermetic tests); production always passes the repository-backed
// port.
func NewRegisterRateLimiter(limits RegisterLimits, audit domain.AuditRepository) *RegisterRateLimiter {
	if limits.PerIP <= 0 {
		limits.PerIP = DefaultRegisterPerIP
	}
	if limits.PerTarget <= 0 {
		limits.PerTarget = DefaultRegisterPerTarget
	}
	if limits.IPWindow <= 0 {
		limits.IPWindow = DefaultRegisterIPWindow
	}
	if limits.TargetWindow <= 0 {
		limits.TargetWindow = DefaultRegisterTargetWindow
	}
	return &RegisterRateLimiter{
		perIP:     NewRateLimiter(limits.PerIP, limits.IPWindow),
		perTarget: NewRateLimiter(limits.PerTarget, limits.TargetWindow),
		audit:     audit,
	}
}

// Allow records one registration attempt and reports whether it stays within
// both buckets. An empty target email (unparseable or missing body) skips the
// per-target bucket - an unattributable attempt cannot burn the shared
// budget - while the per-IP bucket still applies. Every denial is logged;
// the audit row is written by Middleware, which owns the request provenance.
func (l *RegisterRateLimiter) Allow(ip, targetEmail string) bool {
	target := strings.ToLower(strings.TrimSpace(targetEmail))
	okIP := l.perIP.Allow("register:req:ip:" + ip)
	okTarget := true
	if target != "" {
		okTarget = l.perTarget.Allow("register:req:target:" + target)
	}
	if !okIP || !okTarget {
		slog.Warn("register rate limit exceeded",
			"ip", ip,
			"target_email", target,
			"ip_ok", okIP,
			"target_ok", okTarget,
		)
		return false
	}
	return true
}

// Middleware refuses throttled registrations with the frozen 429 envelope
// and lets the rest through to the handler (and from there to the usecase).
// The target email is read off a buffered copy of the JSON body so the
// handler's own bind still sees the full document.
func (l *RegisterRateLimiter) Middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		ip := c.ClientIP()
		target := registerTargetEmail(c)
		if !l.Allow(ip, target) {
			l.recordThrottle(c, ip, target)
			response.FailWith(c, http.StatusTooManyRequests, RegisterRateLimitCode, RegisterRateLimitMessage)
			c.Abort()
			return
		}
		c.Next()
	}
}

// registerTargetEmail extracts the candidate account email from the request
// body without consuming it: the bytes are restored so the handler binds the
// untouched document. Anything unparseable yields "", which Allow treats as
// unattributable (per-IP bucket only) so a malformed body still gets its 400
// from the handler instead of burning shared budget.
func registerTargetEmail(c *gin.Context) string {
	if c.Request.Body == nil {
		return ""
	}
	raw, err := io.ReadAll(c.Request.Body)
	if err != nil {
		return ""
	}
	c.Request.Body = io.NopCloser(bytes.NewReader(raw))
	var body struct {
		Email string `json:"email"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(body.Email))
}

// recordThrottle appends one best-effort audit row for a refused attempt. It
// mirrors the login-failure row (no actor - the account may not exist - and
// email-only secret-free metadata with the refusal reason); it never fails
// the request, exactly like the login audit call sites.
func (l *RegisterRateLimiter) recordThrottle(c *gin.Context, ip, target string) {
	if l.audit == nil {
		return
	}
	if _, err := l.audit.Append(c.Request.Context(), domain.AuditEntry{
		Action:    domain.AuditActionLoginFailed,
		Entity:    domain.AuditEntityUser,
		IP:        ip,
		UserAgent: c.GetHeader("User-Agent"),
		Metadata:  map[string]string{"email": target, "reason": "rate_limited"},
	}); err != nil {
		slog.Warn("register: audit throttle event failed", "error", err)
	}
}

// RegisterRateLimited answers with the frozen generic 429 envelope and
// aborts the chain. It exists for handler-level call sites that consult
// Allow directly; the route middleware answers inline instead.
func RegisterRateLimited(c *gin.Context) {
	response.FailWith(c, http.StatusTooManyRequests, RegisterRateLimitCode, RegisterRateLimitMessage)
	c.Abort()
}
