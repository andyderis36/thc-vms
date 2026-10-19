package handlers

import (
	"context"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	deliveryhttp "thc-vms/backend/internal/delivery/http"
	"thc-vms/backend/internal/delivery/http/response"
	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/auth"
)

// AuthService is the narrow seam this handler needs: it is satisfied by
// *auth.Service in production and by hand-written fakes in tests.
type AuthService interface {
	Login(ctx context.Context, email, password string) (auth.LoginResult, error)
	Me(ctx context.Context, userID domain.UUID) (auth.Profile, error)
	Logout(ctx context.Context) error
}

// AuthHandler serves POST /auth/login, GET /auth/me and POST /auth/logout.
// Every answer goes through the response envelope; no handler invents a key.
type AuthHandler struct {
	auth AuthService
}

// NewAuthHandler wires the handler to its usecase seam.
func NewAuthHandler(svc AuthService) *AuthHandler {
	return &AuthHandler{auth: svc}
}

// accountDTO mirrors the openapi User schema field for field: id, name,
// email, phone, role, location_id, location_name, status, type, vendor_name,
// plus the nik member (migration 000002). Nullable members stay pointers so
// they render as JSON null (super_admin and vendor carry no branch; accounts
// without a national identity number carry a null nik); the password hash is
// never a member.
type accountDTO struct {
	ID           string       `json:"id"`
	Name         string       `json:"name"`
	Email        string       `json:"email"`
	Phone        string       `json:"phone"`
	NIK          *string      `json:"nik"`
	Role         string       `json:"role"`
	LocationID   *domain.UUID `json:"location_id"`
	LocationName *string      `json:"location_name"`
	Status       string       `json:"status"`
	Type         string       `json:"type"`
	VendorName   *string      `json:"vendor_name"`
}

// nikPtr maps a stored NIK onto the wire shape: "" renders as JSON null,
// a populated value renders as its digit string.
func nikPtr(nik string) *string {
	if nik == "" {
		return nil
	}
	return &nik
}

// profileToAccount projects the usecase profile (which carries no JSON tags)
// onto the openapi User field set.
func profileToAccount(p auth.Profile) accountDTO {
	return accountDTO{
		ID:           string(p.ID),
		Name:         p.Name,
		Email:        p.Email,
		Phone:        p.Phone,
		NIK:          nikPtr(p.NIK),
		Role:         string(p.Role),
		LocationID:   p.LocationID,
		LocationName: p.LocationName,
		Status:       string(p.Status),
		Type:         string(p.Type),
		VendorName:   p.VendorName,
	}
}

// loginBody mirrors LoginRequest: exactly email and password.
type loginBody struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

// loginData mirrors the LoginResponse data object: exactly token and user.
type loginData struct {
	Token string     `json:"token"`
	User  accountDTO `json:"user"`
}

// Login serves POST /auth/login: 200 {token, user}, or 401 with the exact
// "Kredensial tidak valid" sentinel message via domain.FromError.
func (h *AuthHandler) Login(c *gin.Context) {
	var body loginBody
	if err := c.ShouldBindJSON(&body); err != nil {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Format isi permintaan tidak valid.")
		return
	}
	if strings.TrimSpace(body.Email) == "" || body.Password == "" {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Email dan password wajib diisi.")
		return
	}
	// The login audit row needs the request provenance (IP + User-Agent):
	// it travels on the context so the usecase stays Gin-free.
	ctx := deliveryhttp.ContextWithRequestMeta(c.Request.Context(), c)
	result, err := h.auth.Login(ctx, body.Email, body.Password)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, loginData{Token: result.Token, User: profileToAccount(result.User)})
}

// Me serves GET /auth/me: 200 with the openapi User object as the data
// member, matching the frontend's apiFetch<User> contract.
func (h *AuthHandler) Me(c *gin.Context) {
	id, ok := deliveryhttp.IdentityFrom(c)
	if !ok {
		response.Fail(c, domain.ErrUnauthorized)
		return
	}
	profile, err := h.auth.Me(c.Request.Context(), id.UserID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, profileToAccount(profile))
}

// Logout serves POST /auth/logout. The backend is stateless with no token
// denylist by architectural mandate, so there is nothing server-side to
// invalidate: this is an honest success acknowledgement and the client logs
// out by discarding its token. A nil map encodes to null, which the envelope
// omits, so the wire shape stays exactly {"success":true}.
func (h *AuthHandler) Logout(c *gin.Context) {
	if err := h.auth.Logout(c.Request.Context()); err != nil {
		response.Fail(c, err)
		return
	}
	response.OK[map[string]string](c, nil)
}
