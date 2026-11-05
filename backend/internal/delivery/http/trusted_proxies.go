package http

import (
	"fmt"
	"log/slog"
	"net"
	"os"
	"strings"

	"github.com/gin-gonic/gin"
)

// TrustedProxiesEnv is the comma-separated list of reverse-proxy origins
// (plain IPs or CIDRs, e.g. "10.0.0.5" or "10.0.0.0/24,2001:db8::/32") whose
// X-Forwarded-For / X-Real-IP headers ClientIP may honor. It exists so the
// per-IP limiter buckets (login, register, email-change) key on the real
// client again when the backend sits behind the Caddy reverse proxy: without
// it every production client shares the proxy's single IP bucket.
//
// Empty or unset means "trust nothing" (SetTrustedProxies(nil)): ClientIP
// returns RemoteAddr directly and a forged X-Forwarded-For can never
// influence rate limiting. This is the correct local/dev default because dev
// connects directly, and unlike gin's own default (trust ALL proxies) it
// cannot be spoofed. A malformed value fails the same closed way: the server
// keeps serving on RemoteAddr-only buckets and logs which entry broke, so a
// typo degrades granularity but never opens blind XFF trust.
const TrustedProxiesEnv = "TRUSTED_PROXIES"

// applyTrustedProxies wires TrustedProxiesEnv into the engine at
// construction. It never returns an error: every failure mode resolves to
// trusting nothing (the spoof-proof closed state) plus a warning log.
func applyTrustedProxies(engine *gin.Engine) {
	raw := os.Getenv(TrustedProxiesEnv)
	proxies, err := parseTrustedProxies(raw)
	if err != nil {
		slog.Warn("ignoring malformed TRUSTED_PROXIES, trusting no proxy",
			"error", err)
		proxies = nil
	}
	// proxies is nil both when the variable is empty/blank (the default)
	// and when it failed to parse (fail-closed above): either way
	// SetTrustedProxies(nil) makes ClientIP return RemoteAddr directly.
	if err := engine.SetTrustedProxies(proxies); err != nil {
		slog.Warn("gin rejected TRUSTED_PROXIES, trusting no proxy",
			"error", err)
		if fallbackErr := engine.SetTrustedProxies(nil); fallbackErr != nil {
			slog.Warn("gin rejected empty trusted proxies", "error", fallbackErr)
		}
	}
}

// parseTrustedProxies splits a comma-separated env value into trimmed
// entries, dropping blanks so a trailing comma cannot widen the trust list.
// A blank input yields (nil, nil): trust nothing. Every non-blank entry must
// be a plain IP or CIDR; the first offender fails the whole value, naming it.
func parseTrustedProxies(raw string) ([]string, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	var out []string
	for _, part := range strings.Split(raw, ",") {
		item := strings.TrimSpace(part)
		if item == "" {
			continue
		}
		if _, _, err := net.ParseCIDR(item); err == nil {
			out = append(out, item)
			continue
		}
		if ip := net.ParseIP(item); ip != nil {
			out = append(out, item)
			continue
		}
		return nil, fmt.Errorf("invalid %s entry %q: must be an IP or CIDR", TrustedProxiesEnv, item)
	}
	if len(out) == 0 {
		return nil, nil
	}
	return out, nil
}
