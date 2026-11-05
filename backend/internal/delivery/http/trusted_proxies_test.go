package http_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	deliveryhttp "thc-vms/backend/internal/delivery/http"
)

// echoClientIPEngine builds the smallest route table exposing ClientIP: the
// health probe answers with whatever c.ClientIP() resolves for the request,
// so the tests below assert the trust decision end to end (RemoteAddr +
// X-Forwarded-For -> ClientIP) instead of pinning parsing internals.
func echoClientIPEngine() *gin.Engine {
	return deliveryhttp.New(deliveryhttp.Deps{
		Health: deliveryhttp.HealthProbes{
			Health: func(c *gin.Context) { c.String(http.StatusOK, c.ClientIP()) },
		},
	})
}

// serveClientIP issues one GET /api/v1/health with the given RemoteAddr and
// optional X-Forwarded-For and returns the resolved client IP.
func serveClientIP(t *testing.T, remoteAddr, xff string) string {
	t.Helper()
	engine := echoClientIPEngine()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	req.RemoteAddr = remoteAddr
	if xff != "" {
		req.Header.Set("X-Forwarded-For", xff)
	}
	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %q", rec.Code, rec.Body.String())
	}
	return strings.TrimSpace(rec.Body.String())
}

// TestTrustedProxies_EmptyEnvIgnoresSpoofedXFF pins the default: without
// TRUSTED_PROXIES a forged X-Forwarded-For must never influence ClientIP, so
// the per-IP limiter buckets stay keyed by the connecting proxy (RemoteAddr).
func TestTrustedProxies_EmptyEnvIgnoresSpoofedXFF(t *testing.T) {
	t.Setenv(deliveryhttp.TrustedProxiesEnv, "")
	if got := serveClientIP(t, "10.0.0.1:5678", "203.0.113.7"); got != "10.0.0.1" {
		t.Fatalf("ClientIP = %q, want RemoteAddr host %q (spoofed XFF must be ignored)", got, "10.0.0.1")
	}
}

// TestTrustedProxies_TrustedProxyUsesXFFClientIP pins the Caddy case: when
// the connecting proxy is listed, ClientIP resolves the real client from
// X-Forwarded-For and the per-IP limiter buckets become per-client again.
func TestTrustedProxies_TrustedProxyUsesXFFClientIP(t *testing.T) {
	t.Setenv(deliveryhttp.TrustedProxiesEnv, "10.0.0.1")
	if got := serveClientIP(t, "10.0.0.1:5678", "203.0.113.7"); got != "203.0.113.7" {
		t.Fatalf("ClientIP = %q, want XFF client %q (trusted proxy must forward)", got, "203.0.113.7")
	}
}

// TestTrustedProxies_TrustedCIDRUsesXFFClientIP covers the deployment form:
// Caddy's address arrives inside a trusted CIDR range, not as a single IP.
func TestTrustedProxies_TrustedCIDRUsesXFFClientIP(t *testing.T) {
	t.Setenv(deliveryhttp.TrustedProxiesEnv, "10.0.0.0/24")
	if got := serveClientIP(t, "10.0.0.5:5678", "203.0.113.7"); got != "203.0.113.7" {
		t.Fatalf("ClientIP = %q, want XFF client %q (trusted CIDR must forward)", got, "203.0.113.7")
	}
}

// TestTrustedProxies_MalformedEnvFailsClosed pins the malformed case: a
// broken TRUSTED_PROXIES value must trust nothing (spoofed XFF ignored), so
// a typo can never silently open blind XFF trust.
func TestTrustedProxies_MalformedEnvFailsClosed(t *testing.T) {
	t.Setenv(deliveryhttp.TrustedProxiesEnv, "not-an-ip")
	if got := serveClientIP(t, "10.0.0.1:5678", "203.0.113.7"); got != "10.0.0.1" {
		t.Fatalf("ClientIP = %q, want RemoteAddr host %q (malformed env must trust nothing)", got, "10.0.0.1")
	}
}
