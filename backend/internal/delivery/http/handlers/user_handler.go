package handlers

import (
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"

	deliveryhttp "thc-vms/backend/internal/delivery/http"
	"thc-vms/backend/internal/delivery/http/middleware"
	"thc-vms/backend/internal/delivery/http/response"
	"thc-vms/backend/internal/domain"
)

// bcryptCost is the bcrypt work factor for security-account passwords. The
// value 10 equals bcrypt.DefaultCost and is named (never a magic literal) so
// deployments can reason about the hashing budget in one place.
const bcryptCost = 10

// UserHandler serves the branch security-account endpoints: listing,
// registration and status flips. It talks to the domain ports directly; the
// only security-specific knowledge here is the injected role id, because the
// domain port has no "create a user with a role name" convenience.
type UserHandler struct {
	users          domain.UserRepository
	locations      domain.MasterDataRepository
	securityRoleID domain.UUID
}

// NewUserHandler wires the handler to the user and master-data ports.
// securityRoleID is the role row for "security", resolved once at startup so
// every account created here carries the gate-staff role.
func NewUserHandler(users domain.UserRepository, locations domain.MasterDataRepository, securityRoleID domain.UUID) *UserHandler {
	return &UserHandler{users: users, locations: locations, securityRoleID: securityRoleID}
}

// userToAccount projects one stored security account onto the openapi User
// field set. The role is fixed: this endpoint only ever serves gate staff.
func userToAccount(u domain.User, locationName *string) accountDTO {
	return accountDTO{
		ID:           string(u.ID),
		Name:         u.Name,
		Email:        u.Email,
		Phone:        u.Phone,
		Role:         string(domain.RoleSecurity),
		LocationID:   u.LocationID,
		LocationName: locationName,
		Status:       string(u.Status),
		Type:         string(u.Type),
		VendorName:   nil,
	}
}

// branchName resolves a branch id to its display name on a best-effort
// basis: a catalogue miss leaves the name null rather than failing the row.
func (h *UserHandler) branchName(c *gin.Context, id *domain.UUID) *string {
	if id == nil {
		return nil
	}
	loc, err := h.locations.FindLocationByID(c.Request.Context(), *id)
	if err != nil {
		return nil
	}
	name := loc.Name
	return &name
}

// ListSecurity serves GET /users/security. An admin sees only its own
// branch, a super_admin sees all or narrows with ?location_id=; every other
// role gets 403 with the sentinel message.
func (h *UserHandler) ListSecurity(c *gin.Context) {
	id, ok := deliveryhttp.IdentityFrom(c)
	if !ok {
		response.Fail(c, domain.ErrUnauthorized)
		return
	}
	if id.Role != domain.RoleSuperAdmin && id.Role != domain.RoleAdmin {
		response.Fail(c, domain.ErrForbiddenBranch)
		return
	}
	var scope *domain.UUID
	if id.Role == domain.RoleSuperAdmin {
		if raw := strings.TrimSpace(c.Query("location_id")); raw != "" {
			locationID := domain.UUID(raw)
			scope = &locationID
		}
	} else {
		if id.LocationID == nil {
			response.Fail(c, domain.ErrForbiddenBranch)
			return
		}
		scope = id.LocationID
	}
	accounts, err := h.users.ListSecurity(c.Request.Context(), scope)
	if err != nil {
		response.Fail(c, err)
		return
	}
	out := make([]accountDTO, 0, len(accounts))
	for _, u := range accounts {
		out = append(out, userToAccount(u, h.branchName(c, u.LocationID)))
	}
	response.OK(c, out)
}

// createSecurityBody mirrors CreateSecurityUserRequest: name, email and
// password are mandatory; location_id is honoured for super_admin only.
type createSecurityBody struct {
	Name       string `json:"name"`
	Email      string `json:"email"`
	Phone      string `json:"phone"`
	Password   string `json:"password"`
	LocationID string `json:"location_id"`
}

// CreateSecurity serves POST /users/security with 201. An admin's
// location_id is FORCED to its own branch regardless of the request body
// (openapi L691: "Diabaikan untuk Admin Cabang"); a super_admin must pass
// one. The password is bcrypt-hashed at cost 10 and never stored plaintext.
func (h *UserHandler) CreateSecurity(c *gin.Context) {
	id, ok := deliveryhttp.IdentityFrom(c)
	if !ok {
		response.Fail(c, domain.ErrUnauthorized)
		return
	}
	if id.Role != domain.RoleSuperAdmin && id.Role != domain.RoleAdmin {
		response.Fail(c, domain.ErrForbiddenBranch)
		return
	}
	var body createSecurityBody
	if err := c.ShouldBindJSON(&body); err != nil {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Format isi permintaan tidak valid.")
		return
	}
	if strings.TrimSpace(body.Name) == "" || strings.TrimSpace(body.Email) == "" || body.Password == "" {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Nama, email, dan password wajib diisi.")
		return
	}
	var locationID *domain.UUID
	if id.Role == domain.RoleAdmin {
		if id.LocationID == nil {
			response.Fail(c, domain.ErrForbiddenBranch)
			return
		}
		locationID = id.LocationID
	} else {
		if strings.TrimSpace(body.LocationID) == "" {
			response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "location_id wajib diisi.")
			return
		}
		parsed := domain.UUID(strings.TrimSpace(body.LocationID))
		locationID = &parsed
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(body.Password), bcryptCost)
	if err != nil {
		response.Fail(c, err)
		return
	}
	created, err := h.users.Create(c.Request.Context(), domain.User{
		Name:         strings.TrimSpace(body.Name),
		Email:        strings.TrimSpace(body.Email),
		Phone:        strings.TrimSpace(body.Phone),
		PasswordHash: string(hash),
		RoleID:       h.securityRoleID,
		LocationID:   locationID,
		Type:         domain.UserTypeInternal,
		Status:       domain.UserStatusActive,
	})
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.Created(c, userToAccount(created, h.branchName(c, created.LocationID)))
}

// updateStatusBody mirrors UpdateUserStatusRequest. The contract enum is ONLY
// active|inactive: blacklisted is rejected here with 400 before it can reach
// the store.
type updateStatusBody struct {
	Status string `json:"status"`
}

// UpdateSecurityStatus serves PATCH /users/security/{id}/status. Unknown ids
// are 404, cross-branch touches are 403 with the sentinel message, and any
// status outside active|inactive is 400.
func (h *UserHandler) UpdateSecurityStatus(c *gin.Context) {
	id, ok := deliveryhttp.IdentityFrom(c)
	if !ok {
		response.Fail(c, domain.ErrUnauthorized)
		return
	}
	if id.Role != domain.RoleSuperAdmin && id.Role != domain.RoleAdmin {
		response.Fail(c, domain.ErrForbiddenBranch)
		return
	}
	var body updateStatusBody
	if err := c.ShouldBindJSON(&body); err != nil {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Format isi permintaan tidak valid.")
		return
	}
	status := domain.UserStatus(strings.TrimSpace(body.Status))
	if status != domain.UserStatusActive && status != domain.UserStatusInactive {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Status harus active atau inactive.")
		return
	}
	targetID := domain.UUID(strings.TrimSpace(c.Param("id")))
	target, err := h.users.FindByID(c.Request.Context(), targetID)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			response.Fail(c, domain.NotFoundEntity("Akun security"))
			return
		}
		response.Fail(c, err)
		return
	}
	if target.LocationID != nil {
		if err := middleware.CheckBranch(id, *target.LocationID); err != nil {
			response.Fail(c, err)
			return
		}
	} else if id.Role != domain.RoleSuperAdmin {
		response.Fail(c, domain.ErrForbiddenBranch)
		return
	}
	if err := h.users.UpdateStatus(c.Request.Context(), targetID, status); err != nil {
		response.Fail(c, err)
		return
	}
	updated, err := h.users.FindByID(c.Request.Context(), targetID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, userToAccount(updated, h.branchName(c, updated.LocationID)))
}
