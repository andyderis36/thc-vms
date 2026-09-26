package middleware

import (
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/response"
)

// DefaultAuthRateLimit caps login attempts per client per window. The PRD
// sets no threshold, so this number is a deployment choice, not a spec
// constant: wire NewRateLimiter with the value operations wants and keep this
// default (5 attempts per minute per IP) for local development and tests.
const DefaultAuthRateLimit = 5

// DefaultAuthRateWindow is the fixed window the default limit applies to.
const DefaultAuthRateWindow = time.Minute

// bucket counts one client's hits inside the current window.
type bucket struct {
	count     int
	expiresAt time.Time
}

// RateLimiter is the MW1 anti-bruteforce gate for the auth routes: a small
// in-memory fixed-window limiter keyed by client IP. Expired buckets are
// pruned on every decision so memory cannot grow without bound.
type RateLimiter struct {
	mu     sync.Mutex
	limit  int
	window time.Duration
	hits   map[string]*bucket
}

// NewRateLimiter builds a limiter allowing limit hits per window per key.
// A non-positive limit falls back to DefaultAuthRateLimit so a zero value
// can never lock every client out.
func NewRateLimiter(limit int, window time.Duration) *RateLimiter {
	if limit <= 0 {
		limit = DefaultAuthRateLimit
	}
	if window <= 0 {
		window = DefaultAuthRateWindow
	}
	return &RateLimiter{limit: limit, window: window, hits: make(map[string]*bucket)}
}

// Allow records one hit for key and reports whether it stays within the
// limit. It first drops every expired bucket, which bounds the map to the
// clients active in the current window.
func (l *RateLimiter) Allow(key string) bool {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	for k, b := range l.hits {
		if !now.Before(b.expiresAt) {
			delete(l.hits, k)
		}
	}
	b, ok := l.hits[key]
	if !ok || !now.Before(b.expiresAt) {
		l.hits[key] = &bucket{count: 1, expiresAt: now.Add(l.window)}
		return true
	}
	b.count++
	return b.count <= l.limit
}

// Middleware refuses clients past the limit with 429 through the envelope
// and lets the rest through.
func (l *RateLimiter) Middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !l.Allow(c.ClientIP()) {
			response.FailWith(c, http.StatusTooManyRequests, "RATE_LIMITED", "Terlalu banyak percobaan. Silakan coba lagi nanti.")
			c.Abort()
			return
		}
		c.Next()
	}
}
