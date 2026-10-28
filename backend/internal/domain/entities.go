package domain

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// UUID is the identifier type for every uuid column in the ERD. It stays a
// string underneath so adapters convert with one explicit call, while the
// named type keeps branch, user and vendor identifiers apart from free text
// such as the VST-XXXXXXXXXX visit code.
type UUID string

// ParseUUID validates a client-supplied identifier before it can reach a query
// or a path lookup. UUID is a string underneath, so an unvalidated value would
// otherwise travel all the way into a bound parameter; refusing it here turns a
// malformed filter into an immediate, reportable 400 instead of an empty result
// set that looks like a legitimate "no rows".
//
// The canonical 8-4-4-4-12 hexadecimal form is required. A value that is not a
// UUID never identifies a row, so there is nothing to gain by accepting it.
func ParseUUID(raw string) (UUID, error) {
	trimmed := strings.TrimSpace(raw)
	if len(trimmed) != 36 {
		return "", fmt.Errorf("identifier %q is not a UUID: %w", raw, ErrValidation)
	}
	for i, char := range trimmed {
		switch i {
		case 8, 13, 18, 23:
			if char != '-' {
				return "", fmt.Errorf("identifier %q is not a UUID: %w", raw, ErrValidation)
			}
		default:
			isHex := (char >= '0' && char <= '9') ||
				(char >= 'a' && char <= 'f') ||
				(char >= 'A' && char <= 'F')
			if !isHex {
				return "", fmt.Errorf("identifier %q is not a UUID: %w", raw, ErrValidation)
			}
		}
	}
	return UUID(trimmed), nil
}

// RoleName is the RBAC role. super_admin carries a NULL location_id and sees
// every branch; admin and security are locked to one location_id; vendor is an
// external account that owns only its own visits.
type RoleName string

const (
	RoleSuperAdmin RoleName = "super_admin"
	RoleAdmin      RoleName = "admin"
	RoleSecurity   RoleName = "security"
	RoleVendor     RoleName = "vendor"
)

// Role mirrors the ROLE table.
type Role struct {
	ID          UUID
	Name        RoleName
	Permissions json.RawMessage
	CreatedAt   time.Time
}

// UserType separates THC staff from vendor technicians.
type UserType string

const (
	UserTypeInternal UserType = "internal"
	UserTypeExternal UserType = "external"
)

// UserStatus is the account lifecycle: active, inactive or blacklisted.
type UserStatus string

const (
	UserStatusActive      UserStatus = "active"
	UserStatusInactive    UserStatus = "inactive"
	UserStatusBlacklisted UserStatus = "blacklisted"
)

// User mirrors the USER table. LocationID is nil for super_admin and vendor,
// and mandatory for admin and security; VendorID is set for external vendor
// staff only. NIK is the national identity number: "" means SQL NULL
// (mirroring Phone), populated only for admin and vendor accounts. AvatarURL
// is the self-service profile photo's absolute object URL: "" means SQL NULL,
// the same convention as Phone/NIK.
// VendorNameOverride is the manually typed vendor company (migration 000005):
// it is a *string rather than the ""-means-NULL convention of Phone/NIK so
// the stored NULL maps one-to-one onto nil without a sentinel, and so the
// PATCH tri-state (nil keep, "" clear, text set) travels through
// ManagedUserPatch without a second flag. A sent VendorID always wins: the
// write paths discard the manual text instead of storing both, hence an
// override present implies no catalogue link and the read helper
// (resolveVendorDisplayName) can prefer override-otherwise-catalogue.
type User struct {
	ID                 UUID
	Name               string
	Email              string
	PasswordHash       string
	Phone              string
	NIK                string
	AvatarURL          string
	RoleID             UUID
	LocationID         *UUID
	Type               UserType
	Status             UserStatus
	VendorID           *UUID
	VendorNameOverride *string
	LastLogin          *time.Time
	CreatedAt          time.Time
	UpdatedAt          time.Time
}

// Vendor mirrors the VENDOR table: the partner company employing vendor users
// and owning visit requests.
type Vendor struct {
	ID            UUID
	Name          string
	ContactPerson string
	Email         string
	Phone         string
	IsBlacklisted bool
	CreatedAt     time.Time
}

// LocationType is the facility kind. The vocabulary is the ERD's
// pusat | cabang | pop | minipop.
type LocationType string

const (
	LocationPusat   LocationType = "pusat"
	LocationCabang  LocationType = "cabang"
	LocationPOP     LocationType = "pop"
	LocationMiniPOP LocationType = "minipop"
)

// Timezone is the facility's display zone: WIB, WITA or WIT.
type Timezone string

const (
	TimezoneWIB  Timezone = "WIB"
	TimezoneWITA Timezone = "WITA"
	TimezoneWIT  Timezone = "WIT"
)

// Location mirrors the LOCATION table: head office, branch offices, POPs and
// miniPOPs hosting visits.
type Location struct {
	ID       UUID
	Name     string
	Type     LocationType
	Address  string
	City     string
	Timezone Timezone
	IsActive bool
}

// Purpose mirrors the PURPOSE table: the catalogue of visit reasons
// (survey, troubleshoot, maintenance, ...) tagged onto requests.
type Purpose struct {
	ID       UUID
	Name     string
	IsActive bool
}
