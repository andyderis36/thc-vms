package handlers

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"

	deliveryhttp "thc-vms/backend/internal/delivery/http"
	"thc-vms/backend/internal/delivery/http/middleware"
	"thc-vms/backend/internal/delivery/http/response"
	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/superadmin"
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
// Gate staff never carry a NIK (the create/update bodies reject the key),
// so the member renders as JSON null here.
func userToAccount(u domain.User, locationName *string) accountDTO {
	return accountDTO{
		ID:           string(u.ID),
		Name:         u.Name,
		Email:        u.Email,
		Phone:        u.Phone,
		NIK:          nikPtr(u.NIK),
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
// password are mandatory; location_id is honoured for super_admin only. nik
// is accepted ONLY to refuse it: gate staff never carry a national identity
// number (the frontend never sends the key), so a populated value is 400.
type createSecurityBody struct {
	Name       string  `json:"name"`
	Email      string  `json:"email"`
	Phone      string  `json:"phone"`
	Password   string  `json:"password"`
	LocationID string  `json:"location_id"`
	NIK        *string `json:"nik"`
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
	if body.NIK != nil && strings.TrimSpace(*body.NIK) != "" {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "NIK hanya untuk role admin dan vendor.")
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
	// Branch-account isolation: this endpoint only ever serves gate staff. A
	// target carrying any other role answers 404 (never 403) so callers cannot
	// probe or touch admin/vendor/super_admin rows through the security path, and
	// so this route can never collide with PATCH /users/:id/status.
	if target.RoleID != h.securityRoleID {
		response.Fail(c, domain.NotFoundEntity("Akun security"))
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

// securityDeleteStore is the delete half of the account port that
// DeleteSecurity needs beyond domain.UserRepository: the same reference
// pre-checks and the same hard removal DELETE /users/:id relies on. The
// production PostgreSQL adapter satisfies it through
// domain.ManagedUserRepository, so no SQL is duplicated here; the handler
// resolves it with a type assertion so the UserRepository-only fakes of the
// older security tests keep compiling unchanged.
type securityDeleteStore interface {
	CountVisitsByPIC(ctx context.Context, userID domain.UUID) (int64, error)
	CountStaffReferences(ctx context.Context, userID domain.UUID) (int64, error)
	DeleteUser(ctx context.Context, id domain.UUID) error
	// UpdateManagedUser carries the partial edit (PATCH
	// /users/security/:id); the production adapter satisfies it through
	// domain.ManagedUserRepository, narrow fakes keep failing closed.
	UpdateManagedUser(ctx context.Context, id domain.UUID, patch domain.ManagedUserPatch) (domain.User, error)
}

// DeleteSecurity serves DELETE /users/security/:id with 204 and no body. The
// target must be a gate-staff account (any other role answers 404 so this
// route never leaks or collides with DELETE /users/:id); an admin may only
// remove staff stationed at its own branch (cross-branch is 403), while a
// super_admin may remove staff of any branch. A target still named on gate or
// audit rows refuses with 409 via the shared superadmin reference guard, and
// a reference racing the pre-checks surfaces 23503 -> 409 through MapError.
func (h *UserHandler) DeleteSecurity(c *gin.Context) {
	id, ok := deliveryhttp.IdentityFrom(c)
	if !ok {
		response.Fail(c, domain.ErrUnauthorized)
		return
	}
	if id.Role != domain.RoleSuperAdmin && id.Role != domain.RoleAdmin {
		response.Fail(c, domain.ErrForbiddenBranch)
		return
	}
	ctx := c.Request.Context()
	targetID := domain.UUID(strings.TrimSpace(c.Param("id")))
	target, err := h.users.FindByID(ctx, targetID)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			response.Fail(c, domain.NotFoundEntity("Akun security"))
			return
		}
		response.Fail(c, err)
		return
	}
	if target.RoleID != h.securityRoleID {
		response.Fail(c, domain.NotFoundEntity("Akun security"))
		return
	}
	if target.LocationID != nil {
		if err := middleware.CheckBranch(id, *target.LocationID); err != nil {
			response.FailWith(c, http.StatusForbidden, "FORBIDDEN_BRANCH", "Tidak berhak menghapus akun security dari cabang lain.")
			return
		}
	} else if id.Role != domain.RoleSuperAdmin {
		response.FailWith(c, http.StatusForbidden, "FORBIDDEN_BRANCH", "Tidak berhak menghapus akun security dari cabang lain.")
		return
	}
	store, ok := h.users.(securityDeleteStore)
	if !ok {
		// Unreachable with the production adapter (it satisfies the delete
		// half through domain.ManagedUserRepository); fails closed as 500
		// without panicking when a narrow fake is mounted.
		response.Fail(c, domain.ErrDatabase)
		return
	}
	vendorCount, err := store.CountVisitsByPIC(ctx, targetID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	staffCount, err := store.CountStaffReferences(ctx, targetID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	if err := superadmin.CheckUserReferences(vendorCount, staffCount); err != nil {
		response.Fail(c, err)
		return
	}
	if err := store.DeleteUser(ctx, targetID); err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			response.Fail(c, domain.NotFoundEntity("Akun security"))
			return
		}
		response.Fail(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

// updateSecurityBody mirrors the PATCH /users/security/:id body: every
// member is optional (nil keeps the column). Location assignment has no
// member — branch moves go through the super_admin console — and role,
// type and status keep their own flows. nik is accepted ONLY to refuse it,
// mirroring createSecurityBody.
type updateSecurityBody struct {
	Name     *string `json:"name"`
	Email    *string `json:"email"`
	Phone    *string `json:"phone"`
	Password *string `json:"password"`
	NIK      *string `json:"nik"`
}

// UpdateSecurity serves PATCH /users/security/:id with 200 for the branch
// admin's own satpam (and any satpam for super_admin). Guards mirror
// DeleteSecurity: non-security targets 404, cross-branch admins 403, blank
// name/email 400, duplicate email 409. A non-empty password resets the hash.
func (h *UserHandler) UpdateSecurity(c *gin.Context) {
	id, ok := deliveryhttp.IdentityFrom(c)
	if !ok {
		response.Fail(c, domain.ErrUnauthorized)
		return
	}
	if id.Role != domain.RoleSuperAdmin && id.Role != domain.RoleAdmin {
		response.Fail(c, domain.ErrForbiddenBranch)
		return
	}
	var body updateSecurityBody
	if err := c.ShouldBindJSON(&body); err != nil {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Format isi permintaan tidak valid.")
		return
	}
	if body.NIK != nil && strings.TrimSpace(*body.NIK) != "" {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "NIK hanya untuk role admin dan vendor.")
		return
	}
	ctx := c.Request.Context()
	targetID := domain.UUID(strings.TrimSpace(c.Param("id")))
	target, err := h.users.FindByID(ctx, targetID)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			response.Fail(c, domain.NotFoundEntity("Akun security"))
			return
		}
		response.Fail(c, err)
		return
	}
	if target.RoleID != h.securityRoleID {
		response.Fail(c, domain.NotFoundEntity("Akun security"))
		return
	}
	if target.LocationID != nil {
		if err := middleware.CheckBranch(id, *target.LocationID); err != nil {
			response.FailWith(c, http.StatusForbidden, "FORBIDDEN_BRANCH", "Tidak berhak mengubah akun security dari cabang lain.")
			return
		}
	} else if id.Role != domain.RoleSuperAdmin {
		response.FailWith(c, http.StatusForbidden, "FORBIDDEN_BRANCH", "Tidak berhak mengubah akun security dari cabang lain.")
		return
	}
	patch := domain.ManagedUserPatch{}
	if body.Name != nil {
		trimmed := strings.TrimSpace(*body.Name)
		patch.Name = &trimmed
	}
	if body.Email != nil {
		trimmed := strings.TrimSpace(*body.Email)
		patch.Email = &trimmed
	}
	if body.Phone != nil {
		trimmed := strings.TrimSpace(*body.Phone)
		patch.Phone = &trimmed
	}
	if body.Password != nil {
		if *body.Password == "" {
			response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Password baru tidak boleh kosong.")
			return
		}
		hash, err := bcrypt.GenerateFromPassword([]byte(*body.Password), bcryptCost)
		if err != nil {
			response.Fail(c, err)
			return
		}
		hashed := string(hash)
		patch.PasswordHash = &hashed
	}
	if err := superadmin.ValidateManagedUserUpdate(superadmin.ManagedUserPatchInput{
		Role: domain.RoleSecurity, Name: patch.Name, Email: patch.Email, Phone: patch.Phone,
		Password: body.Password,
	}); err != nil {
		response.Fail(c, err)
		return
	}
	store, ok := h.users.(securityDeleteStore)
	if !ok {
		response.Fail(c, domain.ErrDatabase)
		return
	}
	updated, err := store.UpdateManagedUser(ctx, targetID, patch)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, userToAccount(updated, h.branchName(c, updated.LocationID)))
}
