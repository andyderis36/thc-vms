package middleware

import (
	"log/slog"
	"net/http"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/response"
)

// Recovery converts a handler panic into the 500 failure envelope instead of
// killing the connection. The panic value and path go to log/slog; the
// client only sees the generic message, never internals.
func Recovery() gin.HandlerFunc {
	return func(c *gin.Context) {
		defer func() {
			if recovered := recover(); recovered != nil {
				slog.Default().Error("panic recovered",
					"panic", recovered,
					"path", c.Request.URL.Path,
					"method", c.Request.Method,
				)
				if !c.Writer.Written() {
					response.FailWith(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Terjadi kesalahan pada server.")
				}
				c.Abort()
			}
		}()
		c.Next()
	}
}
