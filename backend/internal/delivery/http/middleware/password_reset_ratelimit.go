package middleware

import (
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/response"
)

// Password-reset rate limit thresholds: the request leg (POST
// /auth/password-reset/request) shares 3/hour per target email and 3/hour
// per client IP, while the confirm leg (POST /auth/password-reset/confirm)
// carries its own 10/minute per client IP bucket. These numbers are
// deployment choices, not PRD constants: wire NewPasswordResetRateLimiter
// with the values operations wants and keep these defaults for local
// development and tests.
const (
	DefaultPasswordResetRequestPerTarget = 3
	DefaultPasswordResetRequestPerIP     = 3
	DefaultPasswordResetRequestWindow    = time.Hour
	DefaultPasswordResetConfirmPerIP     = 10
	DefaultPasswordResetConfirmWindow    = time.Minute
)

// PasswordResetRateLimitCode and PasswordResetRateLimitMessage are the frozen
// generic 429 payload for the password-reset endpoints. The message stays
// generic (Bahasa Indonesia) and byte-identical to the login, register and
// email-change throttles so a throttled caller learns nothing about which
// dimension tripped.
const (
	PasswordResetRateLimitCode    = "RATE_LIMITED"
	PasswordResetRateLimitMessage = "Terlalu banyak percobaan. Silakan coba lagi nanti."
)

// PasswordResetLimits tunes a PasswordResetRateLimiter. Any non-positive
// field falls back to its DefaultPasswordReset* constant so a zero value can
// never lock every caller out or disable a bucket.
type PasswordResetLimits struct {
	RequestPerTarget int
	RequestPerIP     int
	RequestWindow    time.Duration
	ConfirmPerIP     int
	ConfirmWindow    time.Duration
}

// DefaultPasswordResetLimits returns the production thresholds above.
func DefaultPasswordResetLimits() PasswordResetLimits {
	return PasswordResetLimits{
		RequestPerTarget: DefaultPasswordResetRequestPerTarget,
		RequestPerIP:     DefaultPasswordResetRequestPerIP,
		RequestWindow:    DefaultPasswordResetRequestWindow,
		ConfirmPerIP:     DefaultPasswordResetConfirmPerIP,
		ConfirmWindow:    DefaultPasswordResetConfirmWindow,
	}
}

// PasswordResetRateLimiter is the anti-abuse gate for the PUBLIC
// password-reset endpoints (no identity exists yet: the caller cannot log
// in). It composes three fixed-window RateLimiter buckets - the same bounded
// in-memory pruning discipline as ratelimit.go, no Redis - under keys
// pwdreset:req:target:<email>, pwdreset:req:ip:<ip> and
// pwdreset:confirm:ip:<ip>. The buckets are separate from the email-change,
// register and login buckets so one flow can never burn another's budget.
// Request calls AllowRequest against the target+IP buckets; confirm calls
// AllowConfirm against the per-IP bucket. Each embedded limiter owns its own
// mutex, so no extra locking is needed here.
type PasswordResetRateLimiter struct {
	reqTarget *RateLimiter
	reqIP     *RateLimiter
	confirm   *RateLimiter
}

// NewPasswordResetRateLimiter builds the limiter from limits, resolving every
// non-positive field to its default first.
func NewPasswordResetRateLimiter(limits PasswordResetLimits) *PasswordResetRateLimiter {
	if limits.RequestPerTarget <= 0 {
		limits.RequestPerTarget = DefaultPasswordResetRequestPerTarget
	}
	if limits.RequestPerIP <= 0 {
		limits.RequestPerIP = DefaultPasswordResetRequestPerIP
	}
	if limits.RequestWindow <= 0 {
		limits.RequestWindow = DefaultPasswordResetRequestWindow
	}
	if limits.ConfirmPerIP <= 0 {
		limits.ConfirmPerIP = DefaultPasswordResetConfirmPerIP
	}
	if limits.ConfirmWindow <= 0 {
		limits.ConfirmWindow = DefaultPasswordResetConfirmWindow
	}
	return &PasswordResetRateLimiter{
		reqTarget: NewRateLimiter(limits.RequestPerTarget, limits.RequestWindow),
		reqIP:     NewRateLimiter(limits.RequestPerIP, limits.RequestWindow),
		confirm:   NewRateLimiter(limits.ConfirmPerIP, limits.ConfirmWindow),
	}
}

// AllowRequest records one request hit and reports whether it stays within
// both buckets. Every bucket is consulted on every call - even when an
// earlier one already denies - so each dimension counts every attempt exactly
// like the email-change limiter does. An empty target email (unparseable or
// missing body) skips the per-target bucket - an unattributable attempt
// cannot burn the shared budget - while the per-IP bucket still applies. Only
// identifiers (IP, target email) are logged; tokens and passwords never reach
// this limiter.
func (l *PasswordResetRateLimiter) AllowRequest(ip, targetEmail string) bool {
	target := strings.ToLower(strings.TrimSpace(targetEmail))
	okIP := l.reqIP.Allow("pwdreset:req:ip:" + ip)
	okTarget := true
	if target != "" {
		okTarget = l.reqTarget.Allow("pwdreset:req:target:" + target)
	}
	if !okIP || !okTarget {
		slog.Warn("password-reset request rate limit exceeded",
			"ip", ip,
			"target_email", target,
			"ip_ok", okIP,
			"target_ok", okTarget,
		)
		return false
	}
	return true
}

// AllowConfirm records one confirm hit against the per-IP bucket and reports
// whether it stays within the limit.
func (l *PasswordResetRateLimiter) AllowConfirm(ip string) bool {
	if !l.confirm.Allow("pwdreset:confirm:ip:" + ip) {
		slog.Warn("password-reset confirm rate limit exceeded",
			"ip", ip,
		)
		return false
	}
	return true
}

// PasswordResetRateLimited answers with the frozen generic 429 envelope and
// aborts the chain. Handlers call it right after a false AllowRequest or
// AllowConfirm and return.
func PasswordResetRateLimited(c *gin.Context) {
	response.FailWith(c, http.StatusTooManyRequests, PasswordResetRateLimitCode, PasswordResetRateLimitMessage)
	c.Abort()
}
