// Package seeddata holds the THC-VMS master data and demo accounts documented
// in docs/5. LOCAL_DEV.md section 6, together with the pure rules that decide
// whether a row may be written.
//
// Everything here is pure: no clock, no randomness, no environment, no
// database. That is what lets the whole plan be validated (and the entire
// seeder dry-run) before a single connection is opened, and it is why this
// package is separate from the command in ../main.go - which must stay a
// single file, because the runbook invokes it as `go run seeds/main.go`
// (docs/5. LOCAL_DEV.md L164) and `go run` on a named file compiles only that
// file.
package seeddata

import (
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
)

// Vocabulary copied verbatim from the CHECK constraints in
// migrations/000001_init_schema.up.sql and the constants in
// internal/domain/entities.go. These are the values the database accepts;
// keeping them in one place stops a stale documentation label from ever
// reaching an INSERT.
const (
	RoleSuperAdmin = "super_admin"
	RoleAdmin      = "admin"
	RoleSecurity   = "security"
	RolePIC        = "pic"

	LocationPusat   = "pusat"
	LocationCabang  = "cabang"
	LocationPOP     = "pop"
	LocationMiniPOP = "minipop"

	UserTypeInternal = "internal"
	UserTypeExternal = "external"

	UserStatusActive = "active"

	TimezoneWIB = "WIB"
)

// locationTypes is the closed facility vocabulary of chk_location_type.
var locationTypes = []string{LocationPusat, LocationCabang, LocationPOP, LocationMiniPOP}

// LocationTypes reports the facility vocabulary chk_location_type accepts.
func LocationTypes() []string { return locationTypes }

// ValidLocationType reports whether t is inside chk_location_type.
func ValidLocationType(t string) bool {
	for _, known := range locationTypes {
		if t == known {
			return true
		}
	}
	return false
}

// Entity namespaces for the deterministic identifier derivation. location,
// purpose and vendor have no natural unique key, so their row id is derived
// from a stable string and the id column is supplied on insert; that is what
// makes ON CONFLICT (id) deterministic instead of minting a fresh random uuid
// on every run. role and users key on their natural unique key instead and let
// the database assign the id.
const (
	EntityRole     = "role"
	EntityLocation = "location"
	EntityPurpose  = "purpose"
	EntityVendor   = "vendor"
)

// seedNamespace anchors every derived identifier. Deriving the namespace from a
// fixed UUIDv5 name keeps the result reproducible on any machine and any Go
// version, and uuid.NewSHA1 cannot fail.
var seedNamespace = uuid.NewSHA1(uuid.NameSpaceURL, []byte("thc-vms.local/seeds/v1"))

// DeriveID maps a stable, human-meaningful key to the uuid stored in the row.
// Distinct entity kinds never collide because the kind is part of the input.
func DeriveID(entity, key string) uuid.UUID {
	return uuid.NewSHA1(seedNamespace, []byte(entity+"\x1f"+key))
}

// SeedRole is one row of the role catalogue. Permissions is raw JSON text
// because the column is jsonb; `{}` is the honest value - no document under
// docs/ defines a permission taxonomy, and migration 000001 records that MVP
// authorisation is driven by role.name alone. Inventing permission keys here
// would create a second, contradictory source of truth.
type SeedRole struct {
	Name        string
	Permissions string
}

// SeedLocation is one facility. Code is the docs/5. LOCAL_DEV.md 6.2 location
// code; the location table has no code column, so the code exists only to
// anchor the deterministic id and to label the plan output.
type SeedLocation struct {
	Code     string
	Name     string
	Type     string
	Address  string
	City     string
	Timezone string
}

// SeedPurpose is one visit reason. Code is the docs/5. LOCAL_DEV.md 6.3 code;
// the purpose table holds only id, name and is_active, so the code anchors the
// deterministic id and no SOP text is invented for the database.
type SeedPurpose struct {
	Code string
	Name string
}

// SeedVendor is one partner company. No document defines a vendor contact
// name, e-mail or phone, so those nullable columns are left empty rather than
// invented.
type SeedVendor struct {
	Name string
}

// SeedUser is one demo account. LocationCode and VendorName are references into
// the location and vendor plans rather than stored ids, so the ids that reach
// the database are derived in exactly one place (ResolveLocationID /
// ResolveVendorID) and cannot drift away from the master rows.
type SeedUser struct {
	Name         string
	Email        string
	Role         string
	LocationCode string
	Type         string
	Status       string
	VendorName   string
}

// SeedPlan is the complete, ordered set of rows the seeder writes. It contains
// no visit, visitor or attendance row: those are authored through the API by
// PICs and branch admins, and pre-seeding them would fabricate an audit trail.
type SeedPlan struct {
	Roles     []SeedRole
	Locations []SeedLocation
	Purposes  []SeedPurpose
	Vendors   []SeedVendor
	Users     []SeedUser
}

// ResolveLocationID returns the deterministic id of a location, or nil for the
// empty key. nil is what the users INSERT sends for super_admin and pic, as
// enforce_user_location_invariant() demands.
func ResolveLocationID(code string) *uuid.UUID {
	if code == "" {
		return nil
	}
	id := DeriveID(EntityLocation, code)
	return &id
}

// ResolveVendorID returns the deterministic id of a vendor, or nil for the
// empty key. Only external vendor staff carry a vendor_id (ERD L47).
func ResolveVendorID(name string) *uuid.UUID {
	if name == "" {
		return nil
	}
	id := DeriveID(EntityVendor, name)
	return &id
}

// CheckInvariant mirrors enforce_user_location_invariant() in Go. The plpgsql
// trigger is the authoritative enforcement; this is the pre-flight pass that
// stops the seeder from opening a transaction whose rows the trigger would
// reject, and it is what a dry run exercises.
func CheckInvariant(role string, locationID *uuid.UUID, userType string) error {
	switch role {
	case RoleSuperAdmin, RoleAdmin, RoleSecurity, RolePIC:
	default:
		return fmt.Errorf("role %q is not in chk_role_name; add its invariant to the trigger before seeding it", role)
	}
	if role == RoleSuperAdmin || role == RolePIC {
		if locationID != nil {
			return fmt.Errorf("role %s must have location_id = NULL, got %s", role, locationID)
		}
	} else if locationID == nil {
		return fmt.Errorf("role %s must be assigned to a facility, got NULL", role)
	}
	if role == RolePIC && userType != UserTypeExternal {
		return fmt.Errorf("role %s must be typed %s, got %q", role, UserTypeExternal, userType)
	}
	return nil
}

// Validate refuses a plan the schema or the trigger would reject. It runs
// before any connection is opened, so the dry run and the real run share one
// rule set.
func Validate(p SeedPlan) error {
	for _, l := range p.Locations {
		if !ValidLocationType(l.Type) {
			return fmt.Errorf("location %s: type %q is not one of %s", l.Code, l.Type, strings.Join(locationTypes, "|"))
		}
	}
	for _, r := range p.Roles {
		switch r.Name {
		case RoleSuperAdmin, RoleAdmin, RoleSecurity, RolePIC:
		default:
			return fmt.Errorf("role %q is not in chk_role_name", r.Name)
		}
	}
	for _, u := range p.Users {
		if err := CheckInvariant(u.Role, ResolveLocationID(u.LocationCode), u.Type); err != nil {
			return fmt.Errorf("user %s: %w", u.Email, err)
		}
		if u.VendorName != "" && u.Type != UserTypeExternal {
			return errors.New("user " + u.Email + ": only external staff may carry a vendor")
		}
	}
	return nil
}

// Plan returns the documented master data and demo accounts of docs/5.
// LOCAL_DEV.md section 6.
//
// Facility types are the migration's vocabulary, not the documentation's
// headings. The headings are stale labels and the mapping applied here is the
// one docs/5. LOCAL_DEV.md 6.2 itself flags:
//
//	head_office  -> pusat    (Kantor Pusat)
//	branch_office -> cabang   (Kantor Cabang)
//	mini_pop     -> minipop
//
// Anything the runbook does not state is left to the schema default rather than
// invented: is_active, status, created_at, updated_at, last_login_at and
// is_blacklisted.
func Plan() SeedPlan {
	return SeedPlan{
		Roles: []SeedRole{
			{Name: RoleSuperAdmin, Permissions: `{}`},
			{Name: RoleAdmin, Permissions: `{}`},
			{Name: RoleSecurity, Permissions: `{}`},
			{Name: RolePIC, Permissions: `{}`},
		},

		// Facilities are verbatim from docs/5. LOCAL_DEV.md section 6.2, apart from
		// the `type` column, which takes the ERD vocabulary (pusat|cabang|pop|minipop)
		// because that is what the schema CHECK constraint enforces. The `code` is
		// the stable key the seed plan upserts on; name and address are the
		// operator-facing SSOT strings.
		Locations: []SeedLocation{
			{
				Code: "HQ-SBY-01", Name: "Kantor Pusat THC (Surabaya)", Type: LocationPusat,
				Address: "Jl. Raya Darmo No. 45, Surabaya", City: "Surabaya", Timezone: TimezoneWIB,
			},
			{
				Code: "BR-MLG-01", Name: "Kantor Cabang Malang", Type: LocationCabang,
				Address: "Jl. Ijen No. 12, Malang", City: "Malang", Timezone: TimezoneWIB,
			},
			{
				Code: "POP-MLG-SWJ", Name: "POP Sawojajar", Type: LocationPOP,
				Address: "Ruko Sawojajar Blok A-4, Malang", City: "Malang", Timezone: TimezoneWIB,
			},
			{
				Code: "POP-SBY-RKT", Name: "POP Rungkut Industri", Type: LocationPOP,
				Address: "Kawasan SIER Rungkut Kav. 9, Surabaya", City: "Surabaya", Timezone: TimezoneWIB,
			},
			{
				Code: "MPOP-MLG-LWG", Name: "miniPOP Lawang", Type: LocationMiniPOP,
				Address: "Shelter Tower THC Lawang, Malang", City: "Malang", Timezone: TimezoneWIB,
			},
		},

		// Purpose names are verbatim from docs/5. LOCAL_DEV.md section 6.3. The
		// codes are the stable keys; the names are operator-facing labels and are
		// not free text to be shortened.
		Purposes: []SeedPurpose{
			{Code: "SPLICING_FO", Name: "Splicing & Maintenance Kabel Fiber Optik"},
			{Code: "GENSET_UPS", Name: "Maintenance Genset & Sistem Catu Daya UPS"},
			{Code: "SERVER_NET", Name: "Troubleshooting Perangkat Server & Router ISP"},
			{Code: "PREVENTIVE", Name: "Preventive Maintenance & Kebersihan Shelter"},
			{Code: "LOGISTICS", Name: "Pengantaran / Penarikan Perangkat & Sparepart"},
			{Code: "AUDIT_SURVEY", Name: "Survey Jalur / Audit Infrastruktur"},
		},

		Vendors: []SeedVendor{
			{Name: "PT Lintas Fiber"},
			{Name: "PT Daya Power Mandiri"},
		},

		// Accounts are verbatim from docs/5. LOCAL_DEV.md section 6.1. The email
		// IS the login identity the QA matrix authenticates with, so these
		// strings are a contract, not sample data: changing one silently breaks
		// every documented test credential.
		Users: []SeedUser{
			{
				Name: "Hendra Wijaya (Super Admin)", Email: "superadmin@thc.net.id", Role: RoleSuperAdmin,
				LocationCode: "", Type: UserTypeInternal, Status: UserStatusActive, VendorName: "",
			},
			{
				Name: "Bayu Santoso (Admin Cabang Surabaya)", Email: "admin.sby@thc.net.id", Role: RoleAdmin,
				LocationCode: "HQ-SBY-01", Type: UserTypeInternal, Status: UserStatusActive, VendorName: "",
			},
			{
				Name: "Dian Permata (Admin Cabang Malang)", Email: "admin.mlg@thc.net.id", Role: RoleAdmin,
				LocationCode: "BR-MLG-01", Type: UserTypeInternal, Status: UserStatusActive, VendorName: "",
			},
			{
				Name: "Joko Susilo (Satpam Pos Gerbang Sby)", Email: "satpam.sby@thc.net.id", Role: RoleSecurity,
				LocationCode: "HQ-SBY-01", Type: UserTypeInternal, Status: UserStatusActive, VendorName: "",
			},
			{
				Name: "Rahmat Hidayat (Satpam Shelter Sawojajar)", Email: "satpam.sawojajar@thc.net.id", Role: RoleSecurity,
				LocationCode: "POP-MLG-SWJ", Type: UserTypeInternal, Status: UserStatusActive, VendorName: "",
			},
			{
				Name: "Dimas Prasetyo (Teknisi PT Lintas Fiber)", Email: "vendor.splicing@mitra-fo.com", Role: RolePIC,
				LocationCode: "", Type: UserTypeExternal, Status: UserStatusActive, VendorName: "PT Lintas Fiber",
			},
			{
				Name: "Eko Gunawan (PT Daya Power Mandiri)", Email: "vendor.genset@dayapower.co.id", Role: RolePIC,
				LocationCode: "", Type: UserTypeExternal, Status: UserStatusActive, VendorName: "PT Daya Power Mandiri",
			},
		},
	}
}
