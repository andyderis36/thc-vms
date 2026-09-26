// Package middleware is MW1-MW3 of the mandated chain (docs/3. Arsitektur
// Auth): rate limit, JWT authentication, RBAC/branch scope, plus the recovery
// and CORS wrappers every route mounts. Middleware never invents an error
// shape: every refusal goes through the response envelope.
package middleware

import (
	"context"
	"log/slog"
	"strings"

	"github.com/gin-gonic/gin"

	deliveryhttp "thc-vms/backend/internal/delivery/http"
	"thc-vms/backend/internal/delivery/http/response"
	"thc-vms/backend/internal/domain"
	infraJWT "thc-vms/backend/internal/infrastructure/jwt"
	"thc-vms/backend/internal/usecase/auth"
)

// TokenParser verifies one bearer token. It is satisfied structurally by the
// infrastructure JWT service, so this package never re-implements signature
// verification.
type TokenParser interface {
	Parse(token string) (infraJWT.Claims, error)
}

// ProfileLoader re-loads the token's account on every request. The lookup is
// the revocation mechanism the stateless architecture has instead of a
// denylist: an account deactivated after its token was minted fails here.
type ProfileLoader interface {
	Me(ctx context.Context, userID domain.UUID) (auth.Profile, error)
}

// bearerPrefix is the only Authorization scheme accepted.
const bearerPrefix = "Bearer "

// JWT is MW2: it parses the bearer token, re-loads the account through the
// auth service (revocation check), and stores the fresh identity for the
// handlers. Missing, malformed and expired tokens - and tokens whose account
// vanished or was deactivated - all become the 401 envelope.
func JWT(parser TokenParser, loader ProfileLoader) gin.HandlerFunc {
	return func(c *gin.Context) {
		header := c.GetHeader("Authorization")
		if !strings.HasPrefix(header, bearerPrefix) {
			unauthorized(c, "jwt: missing bearer token")
			return
		}
		token := strings.TrimSpace(strings.TrimPrefix(header, bearerPrefix))
		if token == "" {
			unauthorized(c, "jwt: empty bearer token")
			return
		}
		claims, err := parser.Parse(token)
		if err != nil {
			unauthorized(c, "jwt: parse failed")
			return
		}
		if claims.Subject == "" {
			unauthorized(c, "jwt: token carries no subject")
			return
		}
		profile, err := loader.Me(c.Request.Context(), domain.UUID(claims.Subject))
		if err != nil {
			unauthorized(c, "jwt: account lookup failed")
			return
		}
		if profile.Status != domain.UserStatusActive {
			unauthorized(c, "jwt: account is not active")
			return
		}
		deliveryhttp.WithIdentity(c, deliveryhttp.Identity{
			UserID:     profile.ID,
			Role:       profile.Role,
			LocationID: profile.LocationID,
		})
		c.Next()
	}
}

// unauthorized logs the server-side cause at debug level and answers the
// fixed 401 envelope. The cause never reaches the client.
func unauthorized(c *gin.Context, reason string) {
	slog.Debug(reason, "path", c.Request.URL.Path)
	response.Fail(c, domain.ErrUnauthorized)
	c.Abort()
}
