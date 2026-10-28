package handlers

import (
	"context"
	"encoding/json"
	"errors"
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
	UpdateSelf(ctx context.Context, actor auth.SelfIdentity, in auth.SelfUpdate) (auth.Profile, error)
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
// avatar_url, editable_fields, plus the nik member (migration 000002).
// Nullable members stay pointers so they render as JSON null (super_admin and
// vendor carry no branch; accounts without a national identity number carry a
// null nik; an account without a profile photo carries a null avatar_url); the
// password hash is never a member.
type accountDTO struct {
	ID             string       `json:"id"`
	Name           string       `json:"name"`
	Email          string       `json:"email"`
	Phone          string       `json:"phone"`
	NIK            *string      `json:"nik"`
	Role           string       `json:"role"`
	LocationID     *domain.UUID `json:"location_id"`
	LocationName   *string      `json:"location_name"`
	Status         string       `json:"status"`
	Type           string       `json:"type"`
	VendorName     *string      `json:"vendor_name"`
	AvatarURL      *string      `json:"avatar_url"`
	EditableFields []string     `json:"editable_fields,omitempty"`
}

// nikPtr maps a stored NIK onto the wire shape: "" renders as JSON null,
// a populated value renders as its digit string.
func nikPtr(nik string) *string {
	if nik == "" {
		return nil
	}
	return &nik
}

// avatarURLPtr maps the stored/presigned avatar onto the wire shape: "" (no
// photo) renders as JSON null, a populated value renders as its URL.
func avatarURLPtr(avatarURL string) *string {
	if avatarURL == "" {
		return nil
	}
	return &avatarURL
}

// profileToAccount projects the usecase profile (which carries no JSON tags)
// onto the openapi User field set.
func profileToAccount(p auth.Profile) accountDTO {
	return accountDTO{
		ID:             string(p.ID),
		Name:           p.Name,
		Email:          p.Email,
		Phone:          p.Phone,
		NIK:            nikPtr(p.NIK),
		Role:           string(p.Role),
		LocationID:     p.LocationID,
		LocationName:   p.LocationName,
		Status:         string(p.Status),
		Type:           string(p.Type),
		VendorName:     p.VendorName,
		AvatarURL:      avatarURLPtr(p.AvatarURL),
		EditableFields: p.EditableFields,
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

// patchMeBody is the strict PATCH /auth/me payload: only the three
// self-service fields are keys. avatar_url stays raw because the openapi
// tri-state ("absent keeps", null removes, string replaces) cannot be
// expressed by a plain *string, where absent and null both decode to nil.
type patchMeBody struct {
	Name      *string         `json:"name"`
	Phone     *string         `json:"phone"`
	AvatarURL json.RawMessage `json:"avatar_url"`
}

// decodeStrictBody binds one JSON body into dst and refuses unknown members,
// so a locked field (email, password, nik, role, type, status, location_id)
// can never be silently accepted and ignored.
func decodeStrictBody(c *gin.Context, dst any) error {
	decoder := json.NewDecoder(c.Request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		return err
	}
	// A second JSON value after the first is not a valid single document; the
	// decoder would otherwise silently ignore it.
	if decoder.More() {
		return errors.New("unexpected trailing JSON value")
	}
	return nil
}

// parseAvatarURL maps the raw avatar member onto the usecase tri-state. Absent
// is (nil, false); null is (nil, true); a string is (value, false). Any other
// JSON type is rejected.
func parseAvatarURL(raw json.RawMessage) (*string, bool, bool) {
	if raw == nil {
		return nil, false, true
	}
	if strings.TrimSpace(string(raw)) == "null" {
		return nil, true, true
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, false, false
	}
	return &value, false, true
}

// PatchMe serves PATCH /auth/me: the caller edits its own profile and gets
// the same User projection GET /auth/me returns. Field-level policy (which
// role may change what) lives in the usecase, so this route carries no role
// middleware; only a malformed or unknown-key body is classified here.
func (h *AuthHandler) PatchMe(c *gin.Context) {
	id, ok := deliveryhttp.IdentityFrom(c)
	if !ok {
		response.Fail(c, domain.ErrUnauthorized)
		return
	}
	var body patchMeBody
	if err := decodeStrictBody(c, &body); err != nil {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Format isi permintaan tidak valid.")
		return
	}
	avatarURL, clearAvatar, ok := parseAvatarURL(body.AvatarURL)
	if !ok {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Format isi permintaan tidak valid.")
		return
	}
	ctx := deliveryhttp.ContextWithRequestMeta(c.Request.Context(), c)
	profile, err := h.auth.UpdateSelf(ctx, auth.SelfIdentity{UserID: id.UserID, Role: id.Role}, auth.SelfUpdate{
		Name:        body.Name,
		Phone:       body.Phone,
		AvatarURL:   avatarURL,
		ClearAvatar: clearAvatar,
	})
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
