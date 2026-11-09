// Package superadmin holds the validation and guard rules behind the
// super_admin back-office endpoints (PRD §4: kelola lokasi + kelola
// admin/vendor). The guard functions are dependency-free: they take plain
// values, return plain results, and never touch a database or a clock, so
// the rules stay unit-testable without fakes. The delete-path storage
// cleanup (delete_objects.go) takes its ports as explicit parameters, so it
// stays equally unit-testable with recording fakes. Guard failures are
// *domain.AppError carrying the exact HTTP status and envelope code the
// handler renders via response.Fail, with Bahasa Indonesia messages matching
// the tone of domain/errors.go.
package superadmin

import (
	"net/http"
	"strconv"
	"strings"

	"golang.org/x/crypto/bcrypt"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/validation"
)

// badRequest builds the 400 VALIDATION_ERROR the handlers render for a
// rejected field value, mirroring response.FailWith(400, "VALIDATION_ERROR").
func badRequest(message string) *domain.AppError {
	return &domain.AppError{Status: http.StatusBadRequest, Code: "VALIDATION_ERROR", Message: message}
}

// forbidden builds the 403 for a refused account-status change. The code is
// the generic FORBIDDEN (not FORBIDDEN_BRANCH: this is not a cross-branch
// touch) and the message names the exact refusal in Bahasa Indonesia.
func forbidden(message string) *domain.AppError {
	return &domain.AppError{Status: http.StatusForbidden, Code: "FORBIDDEN", Message: message}
}

// NormalizeLocationTimezone applies the POST /locations default: an empty
// timezone becomes WIB, otherwise the value must be a known zone.
func NormalizeLocationTimezone(raw string) (domain.Timezone, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return domain.TimezoneWIB, nil
	}
	tz := domain.Timezone(trimmed)
	switch tz {
	case domain.TimezoneWIB, domain.TimezoneWITA, domain.TimezoneWIT:
		return tz, nil
	default:
		return "", badRequest("Zona waktu harus salah satu dari WIB, WITA, WIT.")
	}
}

// LocationCreateInput is the validated shape behind POST /locations.
type LocationCreateInput struct {
	Name    string
	Type    domain.LocationType
	Address string
	City    string
}

// ValidateLocationCreate rejects a POST /locations body before it reaches
// the store. The name is mandatory; address and city stay optional but are
// capped; the type must be the ERD vocabulary.
func ValidateLocationCreate(in LocationCreateInput) error {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return badRequest("Nama fasilitas wajib diisi.")
	}
	if validation.RuneLen(name) > validation.FacilityNameMaxLength {
		return badRequest("Nama fasilitas maksimal " + strconv.Itoa(validation.FacilityNameMaxLength) + " karakter.")
	}
	if validation.RuneLen(strings.TrimSpace(in.Address)) > validation.FacilityAddressMaxLength {
		return badRequest("Alamat fasilitas maksimal " + strconv.Itoa(validation.FacilityAddressMaxLength) + " karakter.")
	}
	if validation.RuneLen(strings.TrimSpace(in.City)) > validation.FacilityCityMaxLength {
		return badRequest("Kota fasilitas maksimal " + strconv.Itoa(validation.FacilityCityMaxLength) + " karakter.")
	}
	switch in.Type {
	case domain.LocationPusat, domain.LocationCabang, domain.LocationPOP, domain.LocationMiniPOP:
		return nil
	default:
		return badRequest("Tipe fasilitas harus salah satu dari pusat, cabang, pop, minipop.")
	}
}

// ValidateLocationPatch rejects a PATCH /locations/:id body: at least one
// member must be present, and every present enum must be in vocabulary. A
// present-but-blank name is rejected; blank address/city members are left
// for the adapter, which stores them as NULL.
func ValidateLocationPatch(patch domain.LocationPatch) error {
	if patch.Name == nil && patch.Type == nil && patch.Address == nil &&
		patch.City == nil && patch.Timezone == nil && patch.IsActive == nil {
		return badRequest("Tidak ada field yang diubah.")
	}
	if patch.Name != nil {
		name := strings.TrimSpace(*patch.Name)
		if name == "" {
			return badRequest("Nama fasilitas wajib diisi.")
		}
		if validation.RuneLen(name) > validation.FacilityNameMaxLength {
			return badRequest("Nama fasilitas maksimal " + strconv.Itoa(validation.FacilityNameMaxLength) + " karakter.")
		}
	}
	if patch.Address != nil {
		if validation.RuneLen(strings.TrimSpace(*patch.Address)) > validation.FacilityAddressMaxLength {
			return badRequest("Alamat fasilitas maksimal " + strconv.Itoa(validation.FacilityAddressMaxLength) + " karakter.")
		}
	}
	if patch.City != nil {
		if validation.RuneLen(strings.TrimSpace(*patch.City)) > validation.FacilityCityMaxLength {
			return badRequest("Kota fasilitas maksimal " + strconv.Itoa(validation.FacilityCityMaxLength) + " karakter.")
		}
	}
	if patch.Type != nil {
		switch *patch.Type {
		case domain.LocationPusat, domain.LocationCabang, domain.LocationPOP, domain.LocationMiniPOP:
		default:
			return badRequest("Tipe fasilitas harus salah satu dari pusat, cabang, pop, minipop.")
		}
	}
	if patch.Timezone != nil {
		switch *patch.Timezone {
		case domain.TimezoneWIB, domain.TimezoneWITA, domain.TimezoneWIT:
		default:
			return badRequest("Zona waktu harus salah satu dari WIB, WITA, WIT.")
		}
	}
	return nil
}

// ValidNIK reports whether nik is a well-formed Nomor Induk Kependudukan:
// exactly 16 ASCII digits, mirroring chk_users_nik in
// migrations/000002_add_user_nik.up.sql. The database CHECK is the second
// line of defence; this runs first so a malformed value is a 400 with a
// Bahasa Indonesia message, never a constraint error.
func ValidNIK(nik string) bool {
	if len(nik) != 16 {
		return false
	}
	for i := 0; i < len(nik); i++ {
		if nik[i] < '0' || nik[i] > '9' {
			return false
		}
	}
	return true
}

// ValidateUserNIK enforces the per-role NIK rule shared by create and update,
// mirroring the location/vendor pairing rules: admin and vendor rows must carry
// a well-formed 16-digit NIK, while security and super_admin rows must not
// carry one at all.
func ValidateUserNIK(role domain.RoleName, nik string) error {
	trimmed := strings.TrimSpace(nik)
	switch role {
	case domain.RoleAdmin, domain.RoleVendor:
		if trimmed == "" {
			return badRequest("NIK wajib diisi untuk role admin dan vendor.")
		}
		if !ValidNIK(trimmed) {
			return badRequest("NIK harus 16 digit numerik.")
		}
		return nil
	default:
		if trimmed != "" {
			return badRequest("NIK hanya untuk role admin dan vendor.")
		}
		return nil
	}
}

// maxManualVendorNameLen caps the manually typed vendor company (migration
// 000005): a rune count on the trimmed value, mirroring the visit usecase
// cap so both write paths speak the same limit.
const maxManualVendorNameLen = 120

// validateManualVendorName rejects an overlong manual company name with the
// same 400 shape as every other field rule here.
func validateManualVendorName(raw string) error {
	if len([]rune(strings.TrimSpace(raw))) > maxManualVendorNameLen {
		return badRequest("Nama perusahaan vendor maksimal 120 karakter.")
	}
	return nil
}

func validateAccountName(raw string) error {
	if validation.RuneLen(strings.TrimSpace(raw)) > validation.NameMaxLength {
		return badRequest("Nama maksimal " + strconv.Itoa(validation.NameMaxLength) + " karakter.")
	}
	return nil
}

func validateAccountEmail(raw string) error {
	email := strings.TrimSpace(raw)
	if validation.RuneLen(email) > validation.EmailMaxLength {
		return badRequest("Email maksimal " + strconv.Itoa(validation.EmailMaxLength) + " karakter.")
	}
	if !validation.ValidEmail(email) {
		return badRequest("Format email tidak valid.")
	}
	return nil
}

func validateAccountPhone(raw string) error {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil
	}
	if validation.PhoneLengthViolation(trimmed) {
		return badRequest("Nomor telepon harus 10–16 digit angka.")
	}
	if !validation.ValidPhone(trimmed) {
		return badRequest("Nomor telepon tidak valid.")
	}
	return nil
}

func validateAccountPassword(raw string) error {
	if raw == "" {
		return nil
	}
	if err := validation.ValidPassword(raw); err != nil {
		return badRequest(err.Error())
	}
	return nil
}

// ManagedUserInput is the validated shape behind POST /users: the raw body
// plus the caller's parsed identifiers. Type is derived by the server, never
// read from the body. VendorName is the manually typed vendor company
// (migration 000005): honoured only when VendorID is absent, never entering
// the vendor catalogue.
type ManagedUserInput struct {
	Name       string
	Email      string
	Password   string
	Phone      string
	NIK        string
	Role       domain.RoleName
	LocationID *domain.UUID
	// LocationIDs is the optional accept-either union: nil means the key was
	// absent (the union is the primary alone), a non-nil value replaces the
	// union with the primary forced first. An explicitly empty list is 400.
	LocationIDs []domain.UUID
	VendorID   *domain.UUID
	VendorName string
}

// ValidateManagedUserCreate enforces the POST /users contract before hashing:
// name/email/password are mandatory with the same non-empty rule as POST
// /users/security; the role must be admin or vendor (super_admin and security
// are refused with a message naming the correct endpoint); an admin must
// carry a branch while a vendor must not (mirroring the
// enforce_user_location_invariant trigger: admin NOT NULL, vendor NULL +
// external); vendor_id belongs to vendor rows only. It returns the server-
// derived account type: internal for admin, external for vendor.
func ValidateManagedUserCreate(in ManagedUserInput) (domain.UserType, error) {
	if strings.TrimSpace(in.Name) == "" || strings.TrimSpace(in.Email) == "" || in.Password == "" {
		return "", badRequest("Nama, email, dan password wajib diisi.")
	}
	if err := validateAccountName(in.Name); err != nil {
		return "", err
	}
	if err := validateAccountEmail(in.Email); err != nil {
		return "", err
	}
	if err := validateAccountPhone(in.Phone); err != nil {
		return "", err
	}
	if err := validateAccountPassword(in.Password); err != nil {
		return "", err
	}
	if err := ValidateUserNIK(in.Role, in.NIK); err != nil {
		return "", err
	}
	if err := validateManualVendorName(in.VendorName); err != nil {
		return "", err
	}
	if in.LocationIDs != nil && len(in.LocationIDs) == 0 {
		return "", badRequest("location_ids tidak boleh kosong.")
	}
	switch in.Role {
	case domain.RoleAdmin:
		if in.LocationID == nil && len(in.LocationIDs) == 0 {
			return "", badRequest("location_id wajib diisi untuk role admin.")
		}
		if in.VendorID != nil {
			return "", badRequest("vendor_id hanya untuk role vendor.")
		}
		if strings.TrimSpace(in.VendorName) != "" {
			return "", badRequest("vendor_name hanya untuk role vendor.")
		}
		return domain.UserTypeInternal, nil
	case domain.RoleVendor:
		if in.LocationID != nil || in.LocationIDs != nil {
			return "", badRequest("Role vendor tidak memakai location_id.")
		}
		return domain.UserTypeExternal, nil
	case domain.RoleSuperAdmin:
		return "", badRequest("Akun super_admin tidak dapat dibuat melalui endpoint ini.")
	case domain.RoleDevSuperAdmin:
		return "", badRequest("Akun dev-superadmin tidak dapat dibuat melalui endpoint ini.")
	case domain.RoleSecurity:
		return "", badRequest("Akun security dibuat melalui POST /users/security.")
	default:
		return "", badRequest("Role harus admin atau vendor.")
	}
}

// ManagedUserPatchInput is the validated shape behind PATCH /users/:id: the
// target's CURRENT role (roles never change here) plus the caller's parsed
// patch. Nil members keep the stored columns; a non-nil empty password is
// rejected (an empty password must never hash into the row).
type ManagedUserPatchInput struct {
	Role       domain.RoleName
	Name       *string
	Email      *string
	Phone      *string
	NIK        *string
	LocationID *domain.UUID
	// LocationIDs carries the PATCH accept-either union (nil keeps the stored
	// branch, non-nil replaces the union). An explicitly empty list is 400.
	LocationIDs []domain.UUID
	VendorID   *domain.UUID
	// VendorName carries the manual vendor company tri-state (migration 000005):
	// nil keeps the stored override, a blank value clears it, a filled value
	// sets it (capped at 120 runes like create).
	VendorName *string
	Password   *string
}

// ValidateManagedUserUpdate enforces the PATCH /users/:id contract before any
// write: an empty patch is 400 (mirroring ValidateLocationPatch); a provided
// name/email must be non-blank; location follows the target's CURRENT role
// exactly like create (an admin row keeps a branch — clearing is impossible
// through COALESCE anyway — while a vendor row must never gain one); vendor_id
// belongs to vendor rows only. Unknown roles are refused so a corrupt row can
// never be edited into a worse state.
func ValidateManagedUserUpdate(in ManagedUserPatchInput) error {
	if in.Name == nil && in.Email == nil && in.Phone == nil && in.NIK == nil && in.LocationID == nil && in.LocationIDs == nil && in.VendorID == nil && in.VendorName == nil && in.Password == nil {
		return badRequest("Tidak ada perubahan yang diberikan.")
	}
	if in.LocationIDs != nil && len(in.LocationIDs) == 0 {
		return badRequest("location_ids tidak boleh kosong.")
	}
	if in.VendorName != nil {
		if err := validateManualVendorName(*in.VendorName); err != nil {
			return err
		}
	}
	// The NIK rule applies only when the key is provided (nil keeps the
	// stored column); an empty value for admin/vendor is rejected like a
	// malformed one, while other roles accept only absence.
	if in.NIK != nil {
		if err := ValidateUserNIK(in.Role, *in.NIK); err != nil {
			return err
		}
	}
	if in.Name != nil {
		if strings.TrimSpace(*in.Name) == "" {
			return badRequest("Nama tidak boleh kosong.")
		}
		if err := validateAccountName(*in.Name); err != nil {
			return err
		}
	}
	if in.Email != nil {
		if strings.TrimSpace(*in.Email) == "" {
			return badRequest("Email tidak boleh kosong.")
		}
		if err := validateAccountEmail(*in.Email); err != nil {
			return err
		}
	}
	if in.Phone != nil {
		if err := validateAccountPhone(*in.Phone); err != nil {
			return err
		}
	}
	if in.Password != nil {
		if *in.Password == "" {
			return badRequest("Password baru tidak boleh kosong.")
		}
		if err := validateAccountPassword(*in.Password); err != nil {
			return err
		}
	}
	switch in.Role {
	case domain.RoleAdmin:
		if in.VendorID != nil {
			return badRequest("vendor_id hanya untuk role vendor.")
		}
		if in.VendorName != nil {
			return badRequest("vendor_name hanya untuk role vendor.")
		}
		return nil
	case domain.RoleVendor:
		if in.LocationID != nil || in.LocationIDs != nil {
			return badRequest("Role vendor tidak memakai location_id.")
		}
		return nil
	case domain.RoleSecurity:
		if in.VendorID != nil {
			return badRequest("vendor_id hanya untuk role vendor.")
		}
		if in.VendorName != nil {
			return badRequest("vendor_name hanya untuk role vendor.")
		}
		return nil
	case domain.RoleSuperAdmin, domain.RoleDevSuperAdmin:
		if in.LocationID != nil || in.LocationIDs != nil {
			return badRequest("Role super_admin tidak memakai location_id.")
		}
		if in.VendorID != nil {
			return badRequest("vendor_id hanya untuk role vendor.")
		}
		if in.VendorName != nil {
			return badRequest("vendor_name hanya untuk role vendor.")
		}
		return nil
	default:
		return badRequest("Role target tidak dikenal.")
	}
}

// CheckManagedPasswordReset guards password resets through PATCH /users/:id:
// another super_admin row is untouchable (mirroring the status/delete guards),
// and resetting your OWN account requires proving the current password —
// bcrypt-compare against the stored hash — so a stolen session alone cannot
// persist into a password takeover. Non-superadmin targets need no proof:
// the super_admin caller is already fully authenticated for them.
func CheckManagedPasswordReset(actorID domain.UUID, target domain.ManagedUser, currentPassword *string) error {
	if domain.IsSuperAdminRole(target.Role) && target.User.ID != actorID {
		return forbidden("Tidak dapat me-reset password super_admin lain.")
	}
	if target.User.ID == actorID {
		if currentPassword == nil || *currentPassword == "" {
			return badRequest("Password saat ini wajib diisi untuk mengubah password sendiri.")
		}
		if err := bcrypt.CompareHashAndPassword([]byte(target.User.PasswordHash), []byte(*currentPassword)); err != nil {
			return &domain.AppError{Status: http.StatusUnauthorized, Code: "INVALID_CREDENTIALS", Message: "Password saat ini salah."}
		}
	}
	return nil
}

// ValidateUserListRole rejects a GET /users ?role= value outside the
// admin|vendor|security vocabulary; an empty value means "every role".
func ValidateUserListRole(raw string) (*domain.RoleName, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, nil
	}
	role := domain.RoleName(trimmed)
	switch role {
	case domain.RoleAdmin, domain.RoleVendor, domain.RoleSecurity:
		return &role, nil
	default:
		return nil, badRequest("Role harus salah satu dari admin, vendor, security.")
	}
}

// CheckUserUpdatePeer guards PATCH /users/:id: no super_admin row may be
// edited by anyone but itself (the self row stays editable, so every other
// super_admin row is untouchable). It mirrors CheckUserStatusChange so all
// account mutations share one refusal vocabulary.
func CheckUserUpdatePeer(actorID domain.UUID, target domain.ManagedUser) error {
	if target.User.ID == actorID {
		return nil
	}
	if domain.IsSuperAdminRole(target.Role) {
		return forbidden("Tidak dapat mengubah akun super_admin lain.")
	}
	return nil
}

// CheckUserStatusChange guards PATCH /users/:id/status: the target must
// exist (found=false renders 404 upstream), the status must be in the
// active|pending|inactive vocabulary (pending admits the approval of a
// never-approved self-registration, active reactivates a deactivated
// account, inactive deactivates), the caller must not flip its own account,
// and no super_admin row may be touched by anyone but itself (which the self
// rule already refuses, so every other super_admin row is untouchable).
func CheckUserStatusChange(actorID domain.UUID, found bool, target domain.ManagedUser, status domain.UserStatus) error {
	if !found {
		return domain.NotFoundEntity("Akun")
	}
	if status != domain.UserStatusActive && status != domain.UserStatusPending && status != domain.UserStatusInactive {
		return badRequest("Status harus active, pending, atau inactive.")
	}
	if target.User.ID == actorID {
		return forbidden("Tidak dapat mengubah status akun sendiri.")
	}
	if domain.IsSuperAdminRole(target.Role) {
		return forbidden("Tidak dapat mengubah status akun super_admin lain.")
	}
	return nil
}
