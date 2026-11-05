package middleware_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/middleware"
)

// testEmailLimits mirrors production thresholds with a long window so no
// bucket expires mid-test; expiry is covered by its own test below.
func testEmailLimits() middleware.EmailChangeLimits {
	return middleware.EmailChangeLimits{
		RequestPerUser:   3,
		RequestPerIP:     10,
		RequestPerTarget: 3,
		ConfirmPerUserIP: 10,
		Window:           time.Hour,
	}
}

func TestEmailChangeRequest_UserBucketTripsIndependently(t *testing.T) {
	limiter := middleware.NewEmailChangeRateLimiter(testEmailLimits())
	// Same user, but a fresh IP and target email every attempt, so only the
	// per-user bucket can fill.
	for i := 1; i <= 3; i++ {
		ip := "10.11.0." + string(rune('0'+i))
		target := "user-bucket-" + string(rune('a'+i)) + "@example.com"
		if !limiter.AllowRequest("user-1", ip, target) {
			t.Fatalf("attempt %d for the same user must pass, only the user bucket fills", i)
		}
	}
	if limiter.AllowRequest("user-1", "10.11.0.9", "user-bucket-z@example.com") {
		t.Fatal("4th request-link attempt for the same user must trip the 3/hour per-user bucket")
	}
}

func TestEmailChangeRequest_IPBucketTripsIndependently(t *testing.T) {
	limiter := middleware.NewEmailChangeRateLimiter(testEmailLimits())
	// Same IP, but a fresh user and target email every attempt, so only the
	// per-IP bucket can fill.
	for i := 1; i <= 10; i++ {
		user := "ip-user-" + string(rune('a'+i%26)) + string(rune('0'+i/26))
		target := "ip-target-" + string(rune('a'+i%26)) + string(rune('0'+i/26)) + "@example.com"
		if !limiter.AllowRequest(user, "10.12.0.7", target) {
			t.Fatalf("attempt %d from the same IP must pass, only the IP bucket fills", i)
		}
	}
	if limiter.AllowRequest("ip-user-last", "10.12.0.7", "ip-target-last@example.com") {
		t.Fatal("11th attempt from the same IP must trip the 10/hour per-IP bucket")
	}
}

func TestEmailChangeRequest_TargetBucketTripsIndependently(t *testing.T) {
	limiter := middleware.NewEmailChangeRateLimiter(testEmailLimits())
	// Same target email, but a fresh user and IP every attempt, so only the
	// per-target-email bucket can fill.
	for i := 1; i <= 3; i++ {
		user := "target-user-" + string(rune('0'+i))
		ip := "10.13.0." + string(rune('0'+i))
		if !limiter.AllowRequest(user, ip, "same-target@example.com") {
			t.Fatalf("attempt %d for the same target email must pass, only the target bucket fills", i)
		}
	}
	if limiter.AllowRequest("target-user-9", "10.13.0.9", "same-target@example.com") {
		t.Fatal("4th attempt for the same target email must trip the 3/hour per-target bucket")
	}
}

func TestEmailChangeRequest_TargetBucketIsCaseInsensitive(t *testing.T) {
	limiter := middleware.NewEmailChangeRateLimiter(testEmailLimits())
	addrs := []string{"Same-Target@Example.com", "same-target@example.com", "SAME-TARGET@EXAMPLE.COM"}
	for i, addr := range addrs {
		user := "ci-user-" + string(rune('0'+i))
		ip := "10.14.0." + string(rune('0'+i))
		if !limiter.AllowRequest(user, ip, addr) {
			t.Fatalf("attempt %d with a differently-cased target must share one bucket and pass", i+1)
		}
	}
	if limiter.AllowRequest("ci-user-9", "10.14.0.9", "same-target@example.com") {
		t.Fatal("4th attempt for the same target email in any case must trip the per-target bucket")
	}
}

func TestEmailChangeRequest_RequestLinkAndResendShareBuckets(t *testing.T) {
	limiter := middleware.NewEmailChangeRateLimiter(testEmailLimits())
	// Request-link and resend-link are two handlers over one AllowRequest
	// call, so interleaved calls consume the same per-user bucket.
	if !limiter.AllowRequest("user-shared", "10.15.0.1", "shared-1@example.com") {
		t.Fatal("request-link attempt 1 must pass")
	}
	if !limiter.AllowRequest("user-shared", "10.15.0.1", "shared-2@example.com") {
		t.Fatal("request-link attempt 2 must pass")
	}
	if !limiter.AllowRequest("user-shared", "10.15.0.1", "shared-3@example.com") {
		t.Fatal("resend-link attempt 3 must pass")
	}
	if limiter.AllowRequest("user-shared", "10.15.0.1", "shared-4@example.com") {
		t.Fatal("resend-link attempt 4 must trip the shared 3/hour per-user bucket")
	}
}

func TestEmailChangeConfirm_CompositeUserIPBucket(t *testing.T) {
	limiter := middleware.NewEmailChangeRateLimiter(testEmailLimits())
	for i := 1; i <= 10; i++ {
		if !limiter.AllowConfirm("user-1", "10.16.0.1") {
			t.Fatalf("confirm attempt %d for the same user+IP must pass", i)
		}
	}
	if limiter.AllowConfirm("user-1", "10.16.0.1") {
		t.Fatal("11th confirm for the same user+IP must trip the 10/hour composite bucket")
	}
	// Either half of the composite key changing must open a fresh bucket.
	if !limiter.AllowConfirm("user-1", "10.16.0.2") {
		t.Fatal("same user from a different IP must use a fresh composite bucket")
	}
	if !limiter.AllowConfirm("user-2", "10.16.0.1") {
		t.Fatal("different user from the same IP must use a fresh composite bucket")
	}
}

func TestEmailChange_WindowExpiryRecovers(t *testing.T) {
	limits := testEmailLimits()
	limits.Window = 40 * time.Millisecond
	limiter := middleware.NewEmailChangeRateLimiter(limits)

	for i := 1; i <= 3; i++ {
		if !limiter.AllowRequest("user-1", "10.17.0.1", "expiry@example.com") {
			t.Fatalf("request attempt %d must pass before the window fills", i)
		}
	}
	if limiter.AllowRequest("user-1", "10.17.0.1", "expiry@example.com") {
		t.Fatal("4th request must trip the per-user bucket before expiry")
	}
	for i := 1; i <= 10; i++ {
		if !limiter.AllowConfirm("user-1", "10.17.0.1") {
			t.Fatalf("confirm attempt %d must pass before the window fills", i)
		}
	}
	if limiter.AllowConfirm("user-1", "10.17.0.1") {
		t.Fatal("11th confirm must trip the composite bucket before expiry")
	}

	time.Sleep(60 * time.Millisecond)

	if !limiter.AllowRequest("user-1", "10.17.0.1", "expiry@example.com") {
		t.Fatal("request must pass again after the window expires")
	}
	if !limiter.AllowConfirm("user-1", "10.17.0.1") {
		t.Fatal("confirm must pass again after the window expires")
	}
}

func TestEmailChange_ZeroLimitsFallBackToDefaults(t *testing.T) {
	limiter := middleware.NewEmailChangeRateLimiter(middleware.EmailChangeLimits{})
	for i := 1; i <= 3; i++ {
		if !limiter.AllowRequest("user-1", "10.18.0.1", "fallback@example.com") {
			t.Fatalf("request attempt %d must pass under default 3/hour per-user", i)
		}
	}
	if limiter.AllowRequest("user-1", "10.18.0.1", "fallback@example.com") {
		t.Fatal("4th request must trip the defaulted 3/hour per-user bucket")
	}
}

func TestEmailChange_RateLimitedBodyIsByteExact(t *testing.T) {
	gin.SetMode(gin.TestMode)
	limiter := middleware.NewEmailChangeRateLimiter(testEmailLimits())
	r := gin.New()
	r.POST("/account/email/request-link", func(c *gin.Context) {
		if !limiter.AllowRequest("user-1", c.ClientIP(), "exact@example.com") {
			middleware.EmailChangeRateLimited(c)
			return
		}
		c.Status(http.StatusOK)
	})

	const want = `{"success":false,"error":{"code":"RATE_LIMITED","message":"Terlalu banyak percobaan. Silakan coba lagi nanti."}}`

	serve := func() (int, string) {
		req := httptest.NewRequest(http.MethodPost, "/account/email/request-link", nil)
		req.RemoteAddr = "10.19.0.1:1234"
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec.Code, rec.Body.String()
	}
	for i := 1; i <= 3; i++ {
		if code, _ := serve(); code != http.StatusOK {
			t.Fatalf("attempt %d = %d, want 200", i, code)
		}
	}
	code, body := serve()
	if code != http.StatusTooManyRequests {
		t.Fatalf("attempt 4 status = %d, want 429", code)
	}
	if body != want {
		t.Fatalf("429 body = %q, want byte-exact %q", body, want)
	}
}
