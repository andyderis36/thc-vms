package handlers

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"

	deliveryhttp "thc-vms/backend/internal/delivery/http"
	"thc-vms/backend/internal/delivery/http/response"
	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/superadmin"
	"thc-vms/backend/internal/validation"
)

// SuperAdminHandler serves the super_admin back-office endpoints (PRD §4):
// facility CRUD (POST/PATCH/DELETE /locations), purpose CRUD
// (POST/PATCH/DELETE /purposes), account management
// (GET/POST/DELETE /users, PATCH /users/:id/status) and the visit purge
// (DELETE /visits/:id). Every answer reuses the openapi-pinned accountDTO
// and masterLocationDTO shapes, so no new JSON key is invented; the three
// DELETEs answer 204 with no body. Role gating is defence in depth: the
// router mounts these routes behind RequireRoles(super_admin), and each
// method re-asserts the role so direct handler tests prove the 403 without
// the middleware.
type SuperAdminHandler struct {
	users        domain.ManagedUserRepository
	locations    domain.LocationAdminRepository
	purposes     domain.PurposeAdminRepository
	visits       domain.VisitRepository
	adminRoleID  domain.UUID
	vendorRoleID domain.UUID
	// audit is the optional trail writer: nil disables emission so hermetic
	// tests and unwired callers behave exactly as before.
	audit domain.AuditRepository
	// storage is the optional object-storage port behind the delete-path
	// cleanup (avatar, assignment letter, visitor photos, check-in photo):
	// nil keeps the DELETEs DB-only, exactly as before Wave-2.
	storage domain.IStorageService
	// checkins resolves a visit's gate photo before the purge cascades the
	// check_in row away; nil skips that key kind.
	checkins domain.CheckInOutRepository
}

// WithAudit attaches the trail writer and returns the handler for chaining.
// Production passes repository.NewAuditRepository(pool); tests pass a fake.
func (h *SuperAdminHandler) WithAudit(audit domain.AuditRepository) *SuperAdminHandler {
	h.audit = audit
	return h
}

// WithStorage attaches the object-storage port and returns the handler for
// chaining. Production passes the MinIO/S3 adapter; a nil port (the zero
// value) disables the second cleanup phase so the delete paths stay DB-only.
func (h *SuperAdminHandler) WithStorage(storage domain.IStorageService) *SuperAdminHandler {
	h.storage = storage
	return h
}

// WithCheckIns attaches the gate-record port used to collect the check-in
// photo key before a visit purge cascades the check_in row away; nil skips
// that key kind.
func (h *SuperAdminHandler) WithCheckIns(checkins domain.CheckInOutRepository) *SuperAdminHandler {
	h.checkins = checkins
	return h
}

// auditEntry builds one trail entry with the request provenance (IP +
// User-Agent) attached. Metadata must stay secret-free: no password, hash or
// token values, only identifiers and labels.
func auditEntry(c *gin.Context, actor domain.UUID, action, entity string, entityID *domain.UUID, meta map[string]string) domain.AuditEntry {
	provenance := deliveryhttp.RequestMetaFromGin(c)
	return domain.AuditEntry{
		ActorID:   &actor,
		Action:    action,
		Entity:    entity,
		EntityID:  entityID,
		IP:        provenance.IP,
		UserAgent: provenance.UserAgent,
		Metadata:  meta,
	}
}

// appendAuditFallback records one trail row outside any mutation transaction:
// the fallback when the mounted store predates the Audited* ports (narrow
// test fakes). It never fails the request; the production path writes the row
// inside the mutation transaction instead, so this runs only for fakes.
func (h *SuperAdminHandler) appendAuditFallback(ctx context.Context, entry domain.AuditEntry) {
	if h.audit == nil {
		return
	}
	if _, err := h.audit.Append(ctx, entry); err != nil {
		slog.Warn("superadmin: audit append failed", "action", entry.Action, "entity", entry.Entity, "error", err)
	}
}

// locationChangedFields names the PATCH /locations/:id members being changed,
// for the location.update metadata. Nil members keep the stored columns.
func locationChangedFields(patch domain.LocationPatch) string {
	var fields []string
	if patch.Name != nil {
		fields = append(fields, "name")
	}
	if patch.Type != nil {
		fields = append(fields, "type")
	}
	if patch.Address != nil {
		fields = append(fields, "address")
	}
	if patch.City != nil {
		fields = append(fields, "city")
	}
	if patch.Timezone != nil {
		fields = append(fields, "timezone")
	}
	if patch.IsActive != nil {
		fields = append(fields, "is_active")
	}
	return strings.Join(fields, ",")
}

// managedUserChangedFields names the PATCH /users/:id members being changed.
// A password member renders as the label "password", never the secret itself.
func managedUserChangedFields(patch domain.ManagedUserPatch) string {
	var fields []string
	if patch.Name != nil {
		fields = append(fields, "name")
	}
	if patch.Email != nil {
		fields = append(fields, "email")
	}
	if patch.Phone != nil {
		fields = append(fields, "phone")
	}
	if patch.NIK != nil {
		fields = append(fields, "nik")
	}
	if patch.LocationID != nil {
		fields = append(fields, "location_id")
	}
	if patch.VendorID != nil {
		fields = append(fields, "vendor_id")
	}
	if patch.VendorName != nil {
		fields = append(fields, "vendor_name")
	}
	if patch.PasswordHash != nil {
		fields = append(fields, "password")
	}
	return strings.Join(fields, ",")
}

// purposeChangedFields names the PATCH /purposes/:id members being changed,
// for the purpose.update metadata. Nil members keep the stored columns.
func purposeChangedFields(patch domain.PurposePatch) string {
	var fields []string
	if patch.Name != nil {
		fields = append(fields, "name")
	}
	if patch.IsActive != nil {
		fields = append(fields, "is_active")
	}
	return strings.Join(fields, ",")
}

// maxUpdateAuditPairs caps the before/after pairs one update trail row
// carries: seven pairs = 14 keys plus the fields CSV = 15, one under the
// domain's 16-key SanitizeMetadata cap (domain/audit.go maxAuditMetaKeys).
// The managed-user patch has eight members, but the password member never
// takes a pair, so seven is also the reachable worst case.
const maxUpdateAuditPairs = 7

// updatePair is one changed member's flat before/after values for the
// additive before.<field>/after.<field> metadata keys. Sides stay raw
// flat strings (never nested); a missing/NULL side is the empty string and
// renders as "—" downstream.
type updatePair struct {
	field  string
	before string
	after  string
}

// secretAuditField reports whether a field label is password/token/secret
// shaped. Such members contribute only their fields-CSV label and never a
// value pair; SanitizeMetadata strips the same shapes again at the
// repository boundary (defence in depth).
func secretAuditField(field string) bool {
	lowered := strings.ToLower(field)
	for _, banned := range []string{"password", "passwd", "pwd", "token", "secret", "hash", "authorization"} {
		if strings.Contains(lowered, banned) {
			return true
		}
	}
	return false
}

// addUpdatePairs merges the before/after pairs into meta beside the
// unchanged fields CSV, skipping secret-shaped members and stopping at
// maxUpdateAuditPairs so the row can never exceed the 16-key cap.
func addUpdatePairs(meta map[string]string, pairs ...updatePair) {
	emitted := 0
	for _, p := range pairs {
		if emitted >= maxUpdateAuditPairs || secretAuditField(p.field) {
			continue
		}
		meta["before."+p.field] = p.before
		meta["after."+p.field] = p.after
		emitted++
	}
}

// locationUpdatePairs pairs each changed LocationPatch member with the
// stored column it replaces, for location.update.
func locationUpdatePairs(stored domain.Location, patch domain.LocationPatch) []updatePair {
	pairs := make([]updatePair, 0, 6)
	if patch.Name != nil {
		pairs = append(pairs, updatePair{field: "name", before: stored.Name, after: *patch.Name})
	}
	if patch.Type != nil {
		pairs = append(pairs, updatePair{field: "type", before: string(stored.Type), after: string(*patch.Type)})
	}
	if patch.Address != nil {
		pairs = append(pairs, updatePair{field: "address", before: stored.Address, after: *patch.Address})
	}
	if patch.City != nil {
		pairs = append(pairs, updatePair{field: "city", before: stored.City, after: *patch.City})
	}
	if patch.Timezone != nil {
		pairs = append(pairs, updatePair{field: "timezone", before: string(stored.Timezone), after: string(*patch.Timezone)})
	}
	if patch.IsActive != nil {
		pairs = append(pairs, updatePair{
			field: "is_active", before: strconv.FormatBool(stored.IsActive), after: strconv.FormatBool(*patch.IsActive),
		})
	}
	return pairs
}

// purposeUpdatePairs pairs each changed PurposePatch member with the
// stored column it replaces, for purpose.update.
func purposeUpdatePairs(stored domain.Purpose, patch domain.PurposePatch) []updatePair {
	pairs := make([]updatePair, 0, 2)
	if patch.Name != nil {
		pairs = append(pairs, updatePair{field: "name", before: stored.Name, after: *patch.Name})
	}
	if patch.IsActive != nil {
		pairs = append(pairs, updatePair{
			field: "is_active", before: strconv.FormatBool(stored.IsActive), after: strconv.FormatBool(*patch.IsActive),
		})
	}
	return pairs
}

// managedUserUpdatePairs pairs each changed ManagedUserPatch member with
// the stored column it replaces, for user.update (superadmin and the
// branch-admin security mirror). The password member is deliberately
// absent: its label stays in the fields CSV and its value (hash or
// plaintext) never enters the trail.
func managedUserUpdatePairs(stored domain.User, patch domain.ManagedUserPatch) []updatePair {
	pairs := make([]updatePair, 0, 7)
	if patch.Name != nil {
		pairs = append(pairs, updatePair{field: "name", before: stored.Name, after: *patch.Name})
	}
	if patch.Email != nil {
		pairs = append(pairs, updatePair{field: "email", before: stored.Email, after: *patch.Email})
	}
	if patch.Phone != nil {
		pairs = append(pairs, updatePair{field: "phone", before: stored.Phone, after: *patch.Phone})
	}
	if patch.NIK != nil {
		pairs = append(pairs, updatePair{field: "nik", before: stored.NIK, after: *patch.NIK})
	}
	if patch.LocationID != nil {
		pairs = append(pairs, updatePair{field: "location_id", before: auditUUID(stored.LocationID), after: string(*patch.LocationID)})
	}
	if patch.VendorID != nil {
		pairs = append(pairs, updatePair{field: "vendor_id", before: auditUUID(stored.VendorID), after: string(*patch.VendorID)})
	}
	if patch.VendorName != nil {
		pairs = append(pairs, updatePair{field: "vendor_name", before: stringOrEmpty(stored.VendorNameOverride), after: *patch.VendorName})
	}
	return pairs
}

// auditUUID renders an optional UUID column as a flat string; NULL becomes
// the empty string, which renders as "—" downstream.
func auditUUID(id *domain.UUID) string {
	if id == nil {
		return ""
	}
	return string(*id)
}

// NewSuperAdminHandler wires the handler to the managed-account, facility,
// purpose and visit ports. adminRoleID and vendorRoleID are the role rows
// resolved once at startup (like the security role id of UserHandler); the
// account type is derived server-side from the role and never read from the
// body.
func NewSuperAdminHandler(users domain.ManagedUserRepository, locations domain.LocationAdminRepository, purposes domain.PurposeAdminRepository, visits domain.VisitRepository, adminRoleID, vendorRoleID domain.UUID) *SuperAdminHandler {
	return &SuperAdminHandler{users: users, locations: locations, purposes: purposes, visits: visits, adminRoleID: adminRoleID, vendorRoleID: vendorRoleID}
}

// requireSuperAdmin refuses anonymous callers with 401 and non-super_admin
// roles with the 403 sentinel, mirroring the router's SuperAdminOnly chain.
// The hidden dev-superadmin passes like super_admin; it is never exposed
// through these endpoints' destructive controls (see the superadmin usecase
// guards, which refuse any touch of either top-level account).
func requireSuperAdmin(c *gin.Context) (deliveryhttp.Identity, bool) {
	id, ok := deliveryhttp.IdentityFrom(c)
	if !ok {
		response.Fail(c, domain.ErrUnauthorized)
		return deliveryhttp.Identity{}, false
	}
	if !domain.IsSuperAdminRole(id.Role) {
		response.Fail(c, domain.ErrForbiddenBranch)
		return deliveryhttp.Identity{}, false
	}
	return id, true
}

// toMasterLocation projects one stored facility onto the Location response
// shape: the openapi field set plus the is_active flag the super_admin
// console renders (the contract pin in contract_test.go carries the same
// key).
func toMasterLocation(loc domain.Location) masterLocationDTO {
	return masterLocationDTO{
		ID:       string(loc.ID),
		Name:     loc.Name,
		Type:     string(loc.Type),
		Address:  loc.Address,
		City:     loc.City,
		Timezone: string(loc.Timezone),
		IsActive: loc.IsActive,
	}
}

// toMasterPurpose projects one stored catalogue purpose onto the Purpose
// response shape: the openapi field set plus the is_active flag the
// super_admin console renders.
func toMasterPurpose(purpose domain.Purpose) masterPurposeDTO {
	return masterPurposeDTO{
		ID:       string(purpose.ID),
		Name:     purpose.Name,
		IsActive: purpose.IsActive,
	}
}

// managedToAccount projects one console row onto the openapi User field set.
// The role comes from the joined role name (never from the request), and the
// password hash is never a member.
func (h *SuperAdminHandler) managedToAccount(m domain.ManagedUser) accountDTO {
	return accountDTO{
		ID:           string(m.User.ID),
		Name:         m.User.Name,
		Email:        m.User.Email,
		Phone:        m.User.Phone,
		NIK:          nikPtr(m.User.NIK),
		Role:         string(m.Role),
		LocationID:   m.User.LocationID,
		LocationName: m.LocationName,
		Status:       string(m.User.Status),
		Type:         string(m.User.Type),
		VendorName:   m.VendorName,
		AvatarURL:    avatarURL(m.User.ID, m.User.AvatarURL),
	}
}

// locationName resolves a branch id to its display name on a best-effort
// basis, mirroring UserHandler.branchName: a catalogue miss leaves the name
// null rather than failing the row.
func (h *SuperAdminHandler) locationName(c *gin.Context, id *domain.UUID) *string {
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

// createLocationBody mirrors the POST /locations body: name and type are
// mandatory, address/city/timezone are optional (timezone defaults to WIB).
type createLocationBody struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Address  string `json:"address"`
	City     string `json:"city"`
	Timezone string `json:"timezone"`
}

// CreateLocation serves POST /locations with 201. Validation rejects a blank
// name, an unknown type or an unknown timezone with 400 before any write.
// The success feeds location.create: same-transaction via the audited port,
// best-effort fallback otherwise.
func (h *SuperAdminHandler) CreateLocation(c *gin.Context) {
	actor, ok := requireSuperAdmin(c)
	if !ok {
		return
	}
	var body createLocationBody
	if err := c.ShouldBindJSON(&body); err != nil {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Format isi permintaan tidak valid.")
		return
	}
	locType := domain.LocationType(strings.TrimSpace(body.Type))
	if err := superadmin.ValidateLocationCreate(superadmin.LocationCreateInput{
		Name: body.Name, Type: locType, Address: body.Address, City: body.City,
	}); err != nil {
		response.Fail(c, err)
		return
	}
	tz, err := superadmin.NormalizeLocationTimezone(body.Timezone)
	if err != nil {
		response.Fail(c, err)
		return
	}
	pending := domain.Location{
		Name:     strings.TrimSpace(body.Name),
		Type:     locType,
		Address:  strings.TrimSpace(body.Address),
		City:     strings.TrimSpace(body.City),
		Timezone: tz,
		IsActive: true,
	}
	ctx := c.Request.Context()
	var created domain.Location
	audited := false
	if store, ok := h.locations.(domain.AuditedLocationRepository); ok {
		created, err = store.CreateLocationAudited(ctx, pending, auditEntry(c, actor.UserID,
			domain.AuditActionLocationCreate, domain.AuditEntityLocation, nil,
			map[string]string{"name": pending.Name, "type": string(pending.Type)}))
		audited = true
	} else {
		created, err = h.locations.CreateLocation(ctx, pending)
	}
	if err != nil {
		response.Fail(c, err)
		return
	}
	if !audited {
		h.appendAuditFallback(ctx, auditEntry(c, actor.UserID,
			domain.AuditActionLocationCreate, domain.AuditEntityLocation, &created.ID,
			map[string]string{"name": created.Name, "type": string(created.Type)}))
	}
	response.Created(c, toMasterLocation(created))
}

// updateLocationBody mirrors the PATCH /locations/:id body: every member is
// a pointer so an absent key leaves its column unchanged.
type updateLocationBody struct {
	Name     *string `json:"name"`
	Type     *string `json:"type"`
	Address  *string `json:"address"`
	City     *string `json:"city"`
	Timezone *string `json:"timezone"`
	IsActive *bool   `json:"is_active"`
}

// UpdateLocation serves PATCH /locations/:id with 200. Unknown ids are 404,
// an empty patch and unknown enum values are 400. Deactivation via
// is_active:false is the supported soft removal; the hard removal lives on
// DELETE /locations/:id (refused with 409 while users or visits reference it).
func (h *SuperAdminHandler) UpdateLocation(c *gin.Context) {
	actor, ok := requireSuperAdmin(c)
	if !ok {
		return
	}
	var body updateLocationBody
	if err := c.ShouldBindJSON(&body); err != nil {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Format isi permintaan tidak valid.")
		return
	}
	patch := domain.LocationPatch{
		Address:  body.Address,
		City:     body.City,
		IsActive: body.IsActive,
	}
	if body.Name != nil {
		name := strings.TrimSpace(*body.Name)
		patch.Name = &name
	}
	if body.Type != nil {
		locType := domain.LocationType(strings.TrimSpace(*body.Type))
		patch.Type = &locType
	}
	if body.Timezone != nil {
		tz := domain.Timezone(strings.TrimSpace(*body.Timezone))
		patch.Timezone = &tz
	}
	if err := superadmin.ValidateLocationPatch(patch); err != nil {
		response.Fail(c, err)
		return
	}
	targetID := domain.UUID(strings.TrimSpace(c.Param("id")))
	ctx := c.Request.Context()
	existing, lookupErr := h.locations.FindLocationByID(ctx, targetID)
	if lookupErr != nil {
		if errors.Is(lookupErr, domain.ErrNotFound) {
			response.Fail(c, domain.NotFoundEntity("Fasilitas"))
			return
		}
		response.Fail(c, lookupErr)
		return
	}
	meta := map[string]string{"fields": locationChangedFields(patch)}
	addUpdatePairs(meta, locationUpdatePairs(existing, patch)...)
	entry := auditEntry(c, actor.UserID, domain.AuditActionLocationUpdate,
		domain.AuditEntityLocation, &targetID, meta)
	var updated domain.Location
	var err error
	audited := false
	if store, ok := h.locations.(domain.AuditedLocationRepository); ok {
		updated, err = store.UpdateLocationAudited(ctx, targetID, patch, entry)
		audited = true
	} else {
		updated, err = h.locations.UpdateLocation(ctx, targetID, patch)
	}
	if err != nil {
		response.Fail(c, err)
		return
	}
	if !audited {
		h.appendAuditFallback(ctx, entry)
	}
	response.OK(c, toMasterLocation(updated))
}

// ListUsers serves GET /users with 200: the account list with optional
// ?role= (admin|vendor|security), ?search= (contains nama/email) and
// ?location_id= filters, and no pagination, consistent with ListSecurity.
func (h *SuperAdminHandler) ListUsers(c *gin.Context) {
	if _, ok := requireSuperAdmin(c); !ok {
		return
	}
	role, err := superadmin.ValidateUserListRole(c.Query("role"))
	if err != nil {
		response.Fail(c, err)
		return
	}
	var locationID *domain.UUID
	if raw := strings.TrimSpace(c.Query("location_id")); raw != "" {
		parsed, err := domain.ParseUUID(raw)
		if err != nil {
			response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "location_id tidak valid.")
			return
		}
		locationID = &parsed
	}
	accounts, err := h.users.ListManagedUsers(c.Request.Context(), domain.UserFilter{
		Role:       role,
		Search:     strings.TrimSpace(c.Query("search")),
		LocationID: locationID,
	})
	if err != nil {
		response.Fail(c, err)
		return
	}
	out := make([]accountDTO, 0, len(accounts))
	for _, m := range accounts {
		out = append(out, h.managedToAccount(m))
	}
	response.OK(c, out)
}

// createManagedUserBody mirrors the POST /users body. role must be admin or
// vendor; location_id is mandatory for admin and forbidden for vendor; vendor_id
// is vendor-only. The account type is derived server-side, never from the body.
type createManagedUserBody struct {
	Name       string `json:"name"`
	Email      string `json:"email"`
	Password   string `json:"password"`
	Phone      string `json:"phone"`
	NIK        string `json:"nik"`
	Role       string `json:"role"`
	LocationID string `json:"location_id"`
	VendorID   string `json:"vendor_id"`
	// VendorName is the manually typed vendor company (migration 000005),
	// honoured only when vendor_id is absent; it never enters the vendor
	// catalogue.
	VendorName string `json:"vendor_name"`
}

// CreateUser serves POST /users with 201. super_admin and security roles are
// refused with a message naming the correct endpoint; a duplicate email
// surfaces the same 23505 -> 409 mapping POST /users/security relies on.
func (h *SuperAdminHandler) CreateUser(c *gin.Context) {
	actor, ok := deliveryhttp.IdentityFrom(c)
	if !ok {
		response.Fail(c, domain.ErrUnauthorized)
		return
	}
	if !domain.IsSuperAdminRole(actor.Role) && actor.Role != domain.RoleAdmin {
		response.Fail(c, domain.ErrForbiddenBranch)
		return
	}
	var body createManagedUserBody
	if err := c.ShouldBindJSON(&body); err != nil {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Format isi permintaan tidak valid.")
		return
	}
	var locationID *domain.UUID
	if raw := strings.TrimSpace(body.LocationID); raw != "" {
		parsed, err := domain.ParseUUID(raw)
		if err != nil {
			response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "location_id tidak valid.")
			return
		}
		locationID = &parsed
	}
	var vendorID *domain.UUID
	if raw := strings.TrimSpace(body.VendorID); raw != "" {
		parsed, err := domain.ParseUUID(raw)
		if err != nil {
			response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "vendor_id tidak valid.")
			return
		}
		vendorID = &parsed
	}
	role := domain.RoleName(strings.TrimSpace(body.Role))
	// Admin cabang hanya boleh mendaftarkan vendor (PRD §4.1: akun vendor
	// didaftarkan Admin THC); pembuatan admin/security/superadmin tetap
	// superadmin-only. Pesan eksplisit per peran pemanggil.
	if actor.Role == domain.RoleAdmin && role != domain.RoleVendor {
		response.FailWith(c, http.StatusForbidden, "FORBIDDEN", "Admin cabang hanya dapat mendaftarkan akun vendor.")
		return
	}
	vendorName := strings.TrimSpace(body.VendorName)
	accountType, err := superadmin.ValidateManagedUserCreate(superadmin.ManagedUserInput{
		Name:       body.Name,
		Email:      body.Email,
		Password:   body.Password,
		Phone:      validation.NormalizePhone(body.Phone),
		NIK:        strings.TrimSpace(body.NIK),
		Role:       role,
		LocationID: locationID,
		VendorID:   vendorID,
		VendorName: vendorName,
	})
	if err != nil {
		response.Fail(c, err)
		return
	}
	roleID := h.adminRoleID
	if role == domain.RoleVendor {
		roleID = h.vendorRoleID
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(body.Password), bcryptCost)
	if err != nil {
		response.Fail(c, err)
		return
	}
	// Catalogue wins: a sent vendor_id discards the manual text instead of
	// storing both, so the read helper's override-otherwise-catalogue stays
	// unambiguous.
	var vendorOverride *string
	if vendorID == nil && vendorName != "" {
		vendorOverride = &vendorName
	}
	pending := domain.User{
		Name:               strings.TrimSpace(body.Name),
		Email:              strings.TrimSpace(body.Email),
		Phone:              validation.NormalizePhone(body.Phone),
		NIK:                strings.TrimSpace(body.NIK),
		PasswordHash:       string(hash),
		RoleID:             roleID,
		LocationID:         locationID,
		Type:               accountType,
		Status:             domain.UserStatusActive,
		VendorID:           vendorID,
		VendorNameOverride: vendorOverride,
	}
	ctx := c.Request.Context()
	var created domain.User
	audited := false
	if store, ok := h.users.(domain.AuditedUserRepository); ok {
		created, err = store.CreateManagedUserAudited(ctx, pending, auditEntry(c, actor.UserID,
			domain.AuditActionUserCreate, domain.AuditEntityUser, nil,
			map[string]string{"email": pending.Email, "role": string(role)}))
		audited = true
	} else {
		created, err = h.users.CreateManagedUser(ctx, pending)
	}
	if err != nil {
		response.Fail(c, err)
		return
	}
	if !audited {
		h.appendAuditFallback(ctx, auditEntry(c, actor.UserID,
			domain.AuditActionUserCreate, domain.AuditEntityUser, &created.ID,
			map[string]string{"email": created.Email, "role": string(role)}))
	}
	// The create projection carries no catalogue join (unlike the detail
	// read), so only a just-typed manual name can render here; a catalogue
	// choice resolves on the next GET /users read.
	var createdVendorName *string
	if created.VendorNameOverride != nil && strings.TrimSpace(*created.VendorNameOverride) != "" {
		createdVendorName = created.VendorNameOverride
	}
	response.Created(c, accountDTO{
		ID:           string(created.ID),
		Name:         created.Name,
		Email:        created.Email,
		Phone:        created.Phone,
		NIK:          nikPtr(created.NIK),
		Role:         string(role),
		LocationID:   created.LocationID,
		LocationName: h.locationName(c, created.LocationID),
		Status:       string(created.Status),
		Type:         string(created.Type),
		VendorName:   createdVendorName,
	})
}

// updateManagedStatusBody mirrors the PATCH /users/:id/status body: the
// contract enum is ONLY active|pending|inactive.
type updateManagedStatusBody struct {
	Status string `json:"status"`
}

// UpdateUserStatus serves PATCH /users/:id/status with 200. Unknown ids are
// 404, flipping the caller's own account is 403, touching another
// super_admin row is 403, and any status outside active|pending|inactive is 400.
func (h *SuperAdminHandler) UpdateUserStatus(c *gin.Context) {
	id, ok := requireSuperAdmin(c)
	if !ok {
		return
	}
	var body updateManagedStatusBody
	if err := c.ShouldBindJSON(&body); err != nil {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Format isi permintaan tidak valid.")
		return
	}
	status := domain.UserStatus(strings.TrimSpace(body.Status))
	targetID := domain.UUID(strings.TrimSpace(c.Param("id")))
	ctx := c.Request.Context()
	target, err := h.users.FindManagedByID(ctx, targetID)
	switch {
	case err == nil:
		if err := superadmin.CheckUserStatusChange(id.UserID, true, target, status); err != nil {
			response.Fail(c, err)
			return
		}
	case errors.Is(err, domain.ErrNotFound):
		response.Fail(c, domain.NotFoundEntity("Akun"))
		return
	default:
		response.Fail(c, err)
		return
	}
	entry := auditEntry(c, id.UserID, domain.AuditActionUserStatus,
		domain.AuditEntityUser, &targetID,
		map[string]string{"from": string(target.User.Status), "to": string(status)})
	audited := false
	if store, ok := h.users.(domain.AuditedUserRepository); ok {
		err = store.UpdateUserStatusAudited(ctx, targetID, status, entry)
		audited = true
	} else {
		err = h.users.UpdateStatus(ctx, targetID, status)
	}
	if err != nil {
		response.Fail(c, err)
		return
	}
	if !audited {
		h.appendAuditFallback(ctx, entry)
	}
	updated, err := h.users.FindManagedByID(c.Request.Context(), targetID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, h.managedToAccount(updated))
}

// updateManagedUserBody mirrors the PATCH /users/:id body: every member is
// optional (nil keeps the column); role, type, status have no members by
// design and can never change here. A non-empty password is bcrypt-hashed
// into password_hash (a reset by super_admin, e.g. locked-out staff).
type updateManagedUserBody struct {
	Name       *string `json:"name"`
	Email      *string `json:"email"`
	Phone      *string `json:"phone"`
	NIK        *string `json:"nik"`
	LocationID *string `json:"location_id"`
	VendorID   *string `json:"vendor_id"`
	// VendorName is the manual vendor company tri-state (migration 000005):
	// absent keeps, empty clears to null, filled sets (max 120 runes).
	VendorName      *string `json:"vendor_name"`
	Password        *string `json:"password"`
	CurrentPassword *string `json:"current_password"`
}

// UpdateUser serves PATCH /users/:id with 200. Unknown ids are 404, blank
// name/email and role-violating location/vendor pairings are 400, and a
// duplicate email is 409. A non-empty password resets the bcrypt hash; role,
// type and status never change here.
func (h *SuperAdminHandler) UpdateUser(c *gin.Context) {
	id, ok := requireSuperAdmin(c)
	if !ok {
		return
	}
	var body updateManagedUserBody
	if err := c.ShouldBindJSON(&body); err != nil {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Format isi permintaan tidak valid.")
		return
	}
	ctx := c.Request.Context()
	targetID := domain.UUID(strings.TrimSpace(c.Param("id")))
	target, err := h.users.FindManagedByID(ctx, targetID)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			response.Fail(c, domain.NotFoundEntity("Akun"))
			return
		}
		response.Fail(c, err)
		return
	}
	var locationID, vendorID *domain.UUID
	if body.LocationID != nil {
		if raw := strings.TrimSpace(*body.LocationID); raw != "" {
			parsed, err := domain.ParseUUID(raw)
			if err != nil {
				response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "location_id tidak valid.")
				return
			}
			locationID = &parsed
		}
	}
	if body.VendorID != nil {
		if raw := strings.TrimSpace(*body.VendorID); raw != "" {
			parsed, err := domain.ParseUUID(raw)
			if err != nil {
				response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "vendor_id tidak valid.")
				return
			}
			vendorID = &parsed
		}
	}
	// Manual-company tri-state (migration 000005): absent keeps the stored
	// override, empty clears it to null, filled sets it. A simultaneously
	// sent vendor_id wins: the manual text is dropped and any stored
	// override is cleared so a stale manual name can never shadow the
	// chosen catalogue row.
	var vendorName *string
	if body.VendorName != nil {
		trimmed := strings.TrimSpace(*body.VendorName)
		vendorName = &trimmed
	}
	if vendorID != nil {
		cleared := ""
		vendorName = &cleared
	}
	patch := domain.ManagedUserPatch{LocationID: locationID, VendorID: vendorID, VendorName: vendorName}
	if body.Name != nil {
		trimmed := strings.TrimSpace(*body.Name)
		patch.Name = &trimmed
	}
	if body.Email != nil {
		trimmed := strings.TrimSpace(*body.Email)
		patch.Email = &trimmed
	}
	if body.Phone != nil {
		trimmed := validation.NormalizePhone(*body.Phone)
		patch.Phone = &trimmed
	}
	if body.NIK != nil {
		trimmed := strings.TrimSpace(*body.NIK)
		patch.NIK = &trimmed
	}
	if body.Password != nil {
		if *body.Password == "" {
			response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Password baru tidak boleh kosong.")
			return
		}
		if err := validation.ValidPassword(*body.Password); err != nil {
			response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", err.Error())
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
		Role: target.Role, Name: patch.Name, Email: patch.Email, Phone: patch.Phone,
		NIK: patch.NIK, LocationID: patch.LocationID, VendorID: patch.VendorID, VendorName: patch.VendorName, Password: body.Password,
	}); err != nil {
		response.Fail(c, err)
		return
	}
	if !h.checkPasswordReset(c, id.UserID, target, body, patch) {
		return
	}
	meta := map[string]string{"fields": managedUserChangedFields(patch)}
	addUpdatePairs(meta, managedUserUpdatePairs(target.User, patch)...)
	entry := auditEntry(c, id.UserID, domain.AuditActionUserUpdate,
		domain.AuditEntityUser, &targetID, meta)
	audited := false
	if store, ok := h.users.(domain.AuditedUserRepository); ok {
		_, err = store.UpdateManagedUserAudited(ctx, targetID, patch, entry)
		audited = true
	} else {
		_, err = h.users.UpdateManagedUser(ctx, targetID, patch)
	}
	if err != nil {
		response.Fail(c, err)
		return
	}
	if !audited {
		h.appendAuditFallback(ctx, entry)
	}
	updated, err := h.users.FindManagedByID(ctx, targetID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, h.managedToAccount(updated))
}

// managedHashStore reads one stored row WITH its bcrypt hash for the
// self-reset proof below. userRepository satisfies it; narrow fakes fail
// closed with 500 instead of panicking.
type managedHashStore interface {
	FindByID(ctx context.Context, id domain.UUID) (domain.User, error)
}

// Password resets go through one extra gate before the update above runs:
// resetting another super_admin is always 403, and resetting your OWN
// account requires proving the current password, so a stolen session alone
// cannot persist into a password takeover. The check lives here (not in the
// patch validator) because it needs the stored hash. Called with a non-nil
// patch.PasswordHash only; returns false when the request is refused.
func (h *SuperAdminHandler) checkPasswordReset(c *gin.Context, actorID domain.UUID, target domain.ManagedUser, body updateManagedUserBody, patch domain.ManagedUserPatch) bool {
	if patch.PasswordHash == nil {
		return true
	}
	hashStore, ok := h.users.(managedHashStore)
	if !ok {
		response.Fail(c, domain.ErrDatabase)
		return false
	}
	full, err := hashStore.FindByID(c.Request.Context(), target.User.ID)
	if err != nil {
		response.Fail(c, err)
		return false
	}
	withHash := target
	withHash.User.PasswordHash = full.PasswordHash
	if err := superadmin.CheckManagedPasswordReset(actorID, withHash, body.CurrentPassword); err != nil {
		response.Fail(c, err)
		return false
	}
	return true
}

// DeleteUser serves DELETE /users/:id with 204 and no body. Unknown ids are
// 404, deleting the caller's own account or any super_admin row is 403, and
// a vendor user that still owns visits (or staff still named on gate/audit rows) is
// 409. The database FK (23503 -> 409 via MapError) is the second line of
// defence for a reference that races the pre-checks.
func (h *SuperAdminHandler) DeleteUser(c *gin.Context) {
	id, ok := requireSuperAdmin(c)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	targetID := domain.UUID(strings.TrimSpace(c.Param("id")))
	target, err := h.users.FindManagedByID(ctx, targetID)
	switch {
	case err == nil:
		if err := superadmin.CheckUserDelete(id.UserID, true, target); err != nil {
			response.Fail(c, err)
			return
		}
	case errors.Is(err, domain.ErrNotFound):
		response.Fail(c, domain.NotFoundEntity("Akun"))
		return
	default:
		response.Fail(c, err)
		return
	}
	vendorCount, err := h.users.CountVisitsByVendorUser(ctx, targetID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	staffCount, err := h.users.CountStaffReferences(ctx, targetID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	if err := superadmin.CheckUserReferences(vendorCount, staffCount); err != nil {
		response.Fail(c, err)
		return
	}
	// Collect the avatar key while the row is still readable (row-first);
	// the batch below runs only after a successful commit (object-second).
	keys := superadmin.CollectUserStorageKeys(h.storage, target)
	entry := auditEntry(c, id.UserID, domain.AuditActionUserDelete,
		domain.AuditEntityUser, &targetID,
		map[string]string{"email": target.User.Email, "role": string(target.Role)})
	audited := false
	err = superadmin.DeleteRowThenObjects(ctx, h.storage, keys, func() error {
		if store, ok := h.users.(domain.AuditedUserRepository); ok {
			audited = true
			return store.DeleteUserAudited(ctx, targetID, entry)
		}
		return h.users.DeleteUser(ctx, targetID)
	})
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			response.Fail(c, domain.NotFoundEntity("Akun"))
			return
		}
		response.Fail(c, err)
		return
	}
	if !audited {
		h.appendAuditFallback(ctx, entry)
	}
	c.Status(http.StatusNoContent)
}

// DeleteLocation serves DELETE /locations/:id with 204 and no body. Unknown
// ids are 404; a facility that still stations users or hosts visits is 409.
// The database FKs (23503 -> 409 via MapError) are the second line of defence
// for a reference that races the pre-checks.
func (h *SuperAdminHandler) DeleteLocation(c *gin.Context) {
	actor, ok := requireSuperAdmin(c)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	targetID := domain.UUID(strings.TrimSpace(c.Param("id")))
	stored, err := h.locations.FindLocationByID(ctx, targetID)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			response.Fail(c, domain.NotFoundEntity("Fasilitas"))
			return
		}
		response.Fail(c, err)
		return
	}
	users, err := h.locations.CountUsersByLocation(ctx, targetID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	visits, err := h.locations.CountVisitsByLocation(ctx, targetID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	if err := superadmin.CheckLocationReferences(users, visits); err != nil {
		response.Fail(c, err)
		return
	}
	entry := auditEntry(c, actor.UserID, domain.AuditActionLocationDelete,
		domain.AuditEntityLocation, &targetID,
		map[string]string{"name": stored.Name, "type": string(stored.Type)})
	audited := false
	if store, ok := h.locations.(domain.AuditedLocationRepository); ok {
		err = store.DeleteLocationAudited(ctx, targetID, entry)
		audited = true
	} else {
		err = h.locations.DeleteLocation(ctx, targetID)
	}
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			response.Fail(c, domain.NotFoundEntity("Fasilitas"))
			return
		}
		response.Fail(c, err)
		return
	}
	if !audited {
		h.appendAuditFallback(ctx, entry)
	}
	c.Status(http.StatusNoContent)
}

// createPurposeBody mirrors the POST /purposes body: the catalogue name is
// the only member; new rows start active.
type createPurposeBody struct {
	Name string `json:"name"`
}

// CreatePurpose serves POST /purposes with 201. Validation rejects a blank
// or overlong name with 400 before any write.
// The success feeds purpose.create: same-transaction via the audited port,
// best-effort fallback otherwise.
func (h *SuperAdminHandler) CreatePurpose(c *gin.Context) {
	actor, ok := requireSuperAdmin(c)
	if !ok {
		return
	}
	var body createPurposeBody
	if err := c.ShouldBindJSON(&body); err != nil {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Format isi permintaan tidak valid.")
		return
	}
	if err := superadmin.ValidatePurposeCreate(body.Name); err != nil {
		response.Fail(c, err)
		return
	}
	pending := domain.Purpose{
		Name:     strings.TrimSpace(body.Name),
		IsActive: true,
	}
	ctx := c.Request.Context()
	var created domain.Purpose
	var err error
	audited := false
	if store, ok := h.purposes.(domain.AuditedPurposeRepository); ok {
		created, err = store.CreatePurposeAudited(ctx, pending, auditEntry(c, actor.UserID,
			domain.AuditActionPurposeCreate, domain.AuditEntityPurpose, nil,
			map[string]string{"name": pending.Name}))
		audited = true
	} else {
		created, err = h.purposes.CreatePurpose(ctx, pending)
	}
	if err != nil {
		response.Fail(c, err)
		return
	}
	if !audited {
		h.appendAuditFallback(ctx, auditEntry(c, actor.UserID,
			domain.AuditActionPurposeCreate, domain.AuditEntityPurpose, &created.ID,
			map[string]string{"name": created.Name}))
	}
	response.Created(c, toMasterPurpose(created))
}

// updatePurposeBody mirrors the PATCH /purposes/:id body: every member is
// a pointer so an absent key leaves its column unchanged.
type updatePurposeBody struct {
	Name     *string `json:"name"`
	IsActive *bool   `json:"is_active"`
}

// UpdatePurpose serves PATCH /purposes/:id with 200. Unknown ids are 404,
// an empty patch and a blank or overlong name are 400. Deactivation via
// is_active:false is the supported soft removal; the hard removal lives on
// DELETE /purposes/:id (refused with 409 while visits still reference it).
func (h *SuperAdminHandler) UpdatePurpose(c *gin.Context) {
	actor, ok := requireSuperAdmin(c)
	if !ok {
		return
	}
	var body updatePurposeBody
	if err := c.ShouldBindJSON(&body); err != nil {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Format isi permintaan tidak valid.")
		return
	}
	patch := domain.PurposePatch{IsActive: body.IsActive}
	if body.Name != nil {
		name := strings.TrimSpace(*body.Name)
		patch.Name = &name
	}
	if err := superadmin.ValidatePurposePatch(patch); err != nil {
		response.Fail(c, err)
		return
	}
	targetID := domain.UUID(strings.TrimSpace(c.Param("id")))
	ctx := c.Request.Context()
	existing, lookupErr := h.purposes.FindPurposeByID(ctx, targetID)
	if lookupErr != nil {
		if errors.Is(lookupErr, domain.ErrNotFound) {
			response.Fail(c, domain.NotFoundEntity("Tujuan kunjungan"))
			return
		}
		response.Fail(c, lookupErr)
		return
	}
	meta := map[string]string{"fields": purposeChangedFields(patch)}
	addUpdatePairs(meta, purposeUpdatePairs(existing, patch)...)
	entry := auditEntry(c, actor.UserID, domain.AuditActionPurposeUpdate,
		domain.AuditEntityPurpose, &targetID, meta)
	var updated domain.Purpose
	var err error
	audited := false
	if store, ok := h.purposes.(domain.AuditedPurposeRepository); ok {
		updated, err = store.UpdatePurposeAudited(ctx, targetID, patch, entry)
		audited = true
	} else {
		updated, err = h.purposes.UpdatePurpose(ctx, targetID, patch)
	}
	if err != nil {
		response.Fail(c, err)
		return
	}
	if !audited {
		h.appendAuditFallback(ctx, entry)
	}
	response.OK(c, toMasterPurpose(updated))
}

// DeletePurpose serves DELETE /purposes/:id with 204 and no body. Unknown
// ids are 404; a purpose still linked from visits is 409. The database FK
// (23503 -> 409 via MapError) is the second line of defence for a reference
// that races the pre-check.
func (h *SuperAdminHandler) DeletePurpose(c *gin.Context) {
	actor, ok := requireSuperAdmin(c)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	targetID := domain.UUID(strings.TrimSpace(c.Param("id")))
	stored, err := h.purposes.FindPurposeByID(ctx, targetID)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			response.Fail(c, domain.NotFoundEntity("Tujuan kunjungan"))
			return
		}
		response.Fail(c, err)
		return
	}
	visits, err := h.purposes.CountVisitsByPurpose(ctx, targetID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	if err := superadmin.CheckPurposeReferences(visits); err != nil {
		response.Fail(c, err)
		return
	}
	entry := auditEntry(c, actor.UserID, domain.AuditActionPurposeDelete,
		domain.AuditEntityPurpose, &targetID,
		map[string]string{"name": stored.Name})
	audited := false
	if store, ok := h.purposes.(domain.AuditedPurposeRepository); ok {
		err = store.DeletePurposeAudited(ctx, targetID, entry)
		audited = true
	} else {
		err = h.purposes.DeletePurpose(ctx, targetID)
	}
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			response.Fail(c, domain.NotFoundEntity("Tujuan kunjungan"))
			return
		}
		response.Fail(c, err)
		return
	}
	if !audited {
		h.appendAuditFallback(ctx, entry)
	}
	c.Status(http.StatusNoContent)
}

// DeleteVisit serves DELETE /visits/:id (super_admin only, any status) with
// 204 and no body. Unknown ids are 404. The child tables (visitor,
// visit_purpose, status_history, check_in, check_out) all carry ON DELETE
// CASCADE, so the single-row delete cleans the roster, purposes, history and
// gate records atomically; there is no 409 on this path.
func (h *SuperAdminHandler) DeleteVisit(c *gin.Context) {
	actor, ok := requireSuperAdmin(c)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	targetID := domain.UUID(strings.TrimSpace(c.Param("id")))
	// Best-effort visit read feeds BOTH the audit metadata and the storage
	// cleanup: the delete below stays the 404 authority, so a read failure
	// only leaves the code and the object keys out (a missed key degrades to
	// an orphan a sweep can retry, never a dangling reference).
	meta := map[string]string{}
	var keys []string
	if visit, err := h.visits.FindByID(ctx, targetID); err == nil {
		if visit.VisitID != "" {
			meta["visit_code"] = visit.VisitID
		}
		keys = superadmin.CollectVisitStorageKeys(h.storage, visit, h.findCheckIn(ctx, targetID))
	}
	entry := auditEntry(c, actor.UserID, domain.AuditActionVisitDelete,
		domain.AuditEntityVisit, &targetID, meta)
	audited := false
	err := superadmin.DeleteRowThenObjects(ctx, h.storage, keys, func() error {
		if store, ok := h.visits.(domain.AuditedVisitRepository); ok {
			audited = true
			return store.DeleteVisitAudited(ctx, targetID, entry)
		}
		return h.visits.DeleteVisit(ctx, targetID)
	})
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			response.Fail(c, domain.NotFoundEntity("Kunjungan"))
			return
		}
		response.Fail(c, err)
		return
	}
	if !audited {
		h.appendAuditFallback(ctx, entry)
	}
	c.Status(http.StatusNoContent)
}

// findCheckIn loads the visit's gate record for storage-key collection: nil
// when the cleanup is unwired, the visit never checked in (ErrNotFound), or
// the read fails. A non-NotFound failure is logged; the purge stays
// best-effort and the delete remains the 404 authority, mirroring the visit
// read above.
func (h *SuperAdminHandler) findCheckIn(ctx context.Context, visitID domain.UUID) *domain.CheckIn {
	if h.checkins == nil {
		return nil
	}
	checkIn, err := h.checkins.FindCheckInByVisit(ctx, visitID)
	if err != nil {
		if !errors.Is(err, domain.ErrNotFound) {
			slog.Warn("superadmin: check-in read skipped for storage cleanup", "visit_id", visitID, "error", err)
		}
		return nil
	}
	return &checkIn
}
