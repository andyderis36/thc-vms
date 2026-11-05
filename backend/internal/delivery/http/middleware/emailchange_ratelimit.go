package middleware

import (
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/response"
)

// Email-change rate limit thresholds: request-link and resend-link share one
// set of buckets (3/hour per user, 10/hour per IP, 3/hour per target email),
// while confirm uses its own composite bucket (10/hour per user+IP). These
// numbers are deployment choices, not PRD constants: wire
// NewEmailChangeRateLimiter with the values operations wants and keep these
// defaults for local development and tests.
const (
	DefaultEmailChangeRequestPerUser   = 3
	DefaultEmailChangeRequestPerIP     = 10
	DefaultEmailChangeRequestPerTarget = 3
	DefaultEmailChangeConfirmPerUserIP = 10
	DefaultEmailChangeWindow           = time.Hour
)

// EmailChangeRateLimitCode and EmailChangeRateLimitMessage are the frozen
// generic 429 payload for the email-change endpoints. The message stays
// generic (Bahasa Indonesia) so a throttled caller learns nothing about
// which dimension tripped.
const (
	EmailChangeRateLimitCode    = "RATE_LIMITED"
	EmailChangeRateLimitMessage = "Terlalu banyak percobaan. Silakan coba lagi nanti."
)

// EmailChangeLimits tunes an EmailChangeRateLimiter. Any non-positive field
// falls back to its DefaultEmailChange* constant so a zero value can never
// lock every caller out or disable a bucket.
type EmailChangeLimits struct {
	RequestPerUser   int
	RequestPerIP     int
	RequestPerTarget int
	ConfirmPerUserIP int
	Window           time.Duration
}

// DefaultEmailChangeLimits returns the production thresholds above.
func DefaultEmailChangeLimits() EmailChangeLimits {
	return EmailChangeLimits{
		RequestPerUser:   DefaultEmailChangeRequestPerUser,
		RequestPerIP:     DefaultEmailChangeRequestPerIP,
		RequestPerTarget: DefaultEmailChangeRequestPerTarget,
		ConfirmPerUserIP: DefaultEmailChangeConfirmPerUserIP,
		Window:           DefaultEmailChangeWindow,
	}
}

// EmailChangeRateLimiter is the anti-abuse gate for the email-change
// endpoints. It composes four fixed-window RateLimiter buckets - the same
// bounded in-memory pruning discipline as ratelimit.go, no Redis - under
// keys emailchange:req:user:<id>, emailchange:req:ip:<ip>,
// emailchange:req:target:<email> and emailchange:confirm:<user>:<ip>.
// Request-link and resend-link call AllowRequest, so both handlers consume
// the same three buckets; confirm calls AllowConfirm against the composite
// user+IP bucket. Each embedded limiter owns its own mutex, so no extra
// locking is needed here.
type EmailChangeRateLimiter struct {
	reqUser   *RateLimiter
	reqIP     *RateLimiter
	reqTarget *RateLimiter
	confirm   *RateLimiter
}

// NewEmailChangeRateLimiter builds the limiter from limits, resolving every
// non-positive field to its default first.
func NewEmailChangeRateLimiter(limits EmailChangeLimits) *EmailChangeRateLimiter {
	if limits.RequestPerUser <= 0 {
		limits.RequestPerUser = DefaultEmailChangeRequestPerUser
	}
	if limits.RequestPerIP <= 0 {
		limits.RequestPerIP = DefaultEmailChangeRequestPerIP
	}
	if limits.RequestPerTarget <= 0 {
		limits.RequestPerTarget = DefaultEmailChangeRequestPerTarget
	}
	if limits.ConfirmPerUserIP <= 0 {
		limits.ConfirmPerUserIP = DefaultEmailChangeConfirmPerUserIP
	}
	if limits.Window <= 0 {
		limits.Window = DefaultEmailChangeWindow
	}
	return &EmailChangeRateLimiter{
		reqUser:   NewRateLimiter(limits.RequestPerUser, limits.Window),
		reqIP:     NewRateLimiter(limits.RequestPerIP, limits.Window),
		reqTarget: NewRateLimiter(limits.RequestPerTarget, limits.Window),
		confirm:   NewRateLimiter(limits.ConfirmPerUserIP, limits.Window),
	}
}

// AllowRequest records one request-link/resend-link hit and reports whether
// it stays within all three buckets. Every bucket is consulted on every
// call - even when an earlier one already denies - so each dimension counts
// every attempt exactly like the single-key login limiter does. Only
// identifiers (user, IP, target email) are logged; tokens and passwords
// never reach this limiter.
func (l *EmailChangeRateLimiter) AllowRequest(userID, ip, targetEmail string) bool {
	target := strings.ToLower(strings.TrimSpace(targetEmail))
	okUser := l.reqUser.Allow("emailchange:req:user:" + userID)
	okIP := l.reqIP.Allow("emailchange:req:ip:" + ip)
	okTarget := l.reqTarget.Allow("emailchange:req:target:" + target)
	if !okUser || !okIP || !okTarget {
		slog.Warn("emailchange request rate limit exceeded",
			"user_id", userID,
			"ip", ip,
			"target_email", target,
			"user_ok", okUser,
			"ip_ok", okIP,
			"target_ok", okTarget,
		)
		return false
	}
	return true
}

// AllowConfirm records one confirm hit against the composite user+IP bucket
// and reports whether it stays within the limit.
func (l *EmailChangeRateLimiter) AllowConfirm(userID, ip string) bool {
	if !l.confirm.Allow("emailchange:confirm:" + userID + ":" + ip) {
		slog.Warn("emailchange confirm rate limit exceeded",
			"user_id", userID,
			"ip", ip,
		)
		return false
	}
	return true
}

// EmailChangeRateLimited answers with the frozen generic 429 envelope and
// aborts the chain. Handlers call it right after a false AllowRequest or
// AllowConfirm and return.
func EmailChangeRateLimited(c *gin.Context) {
	response.FailWith(c, http.StatusTooManyRequests, EmailChangeRateLimitCode, EmailChangeRateLimitMessage)
	c.Abort()
}
