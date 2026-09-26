package middleware

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// defaultAllowedOrigin is the local Next.js frontend. Port 3210 rather than
// the Next.js default 3000: a stale netsh portproxy rule (IP Helper) keeps
// 0.0.0.0:3000 bound on this machine, so package.json pins the dev server to
// 3210 instead of fighting Windows for it. Keep this in sync with the `dev`
// and `start` scripts in frontend/package.json. Production fronts a real origin
// allow-list through this same parameter; nothing is hardcoded beyond the
// documented local default.
const defaultAllowedOrigin = "http://localhost:3210"

// CORS answers preflights and tags real responses for the browser. Allowed
// origins arrive as a parameter so deployments configure them without code
// changes; with none given the local frontend default applies.
func CORS(allowedOrigins ...string) gin.HandlerFunc {
	allowed := make(map[string]bool, len(allowedOrigins))
	for _, origin := range allowedOrigins {
		allowed[origin] = true
	}
	if len(allowed) == 0 {
		allowed[defaultAllowedOrigin] = true
	}
	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		if allowed[origin] {
			c.Header("Access-Control-Allow-Origin", origin)
			c.Header("Vary", "Origin")
		}
		c.Header("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS")
		c.Header("Access-Control-Allow-Headers", "Authorization, Content-Type")
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}
