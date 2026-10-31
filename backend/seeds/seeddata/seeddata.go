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
	// RoleDevSuperAdmin is the hidden highest role (hyphen, not underscore):
	// one internal, global, always-active platform-operator account. It is
	// seeded like any other role row but never surfaces in user-facing
	// lists and is never offered as a selectable role.
	RoleDevSuperAdmin = "dev-superadmin"
	RoleAdmin         = "admin"
	RoleSecurity      = "security"
	RoleVendor        = "vendor"

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
// ResolveVendorID) and cannot drift away from the master rows. NIK is the
// national identity number: populated only for admin and vendor accounts
// (migration 000002), empty for every other role.
type SeedUser struct {
	Name         string
	Email        string
	Role         string
	LocationCode string
	Type         string
	Status       string
	VendorName   string
	NIK          string
}

// Role codes inside the deterministic demo NIK below.
const (
	// RoleCodeAdmin is the 2-digit role segment for admin demo NIKs.
	RoleCodeAdmin = 1
	// RoleCodeVendor is the 2-digit role segment for vendor demo NIKs.
	RoleCodeVendor = 2
)

// demoNIK builds one deterministic, unique 16-digit demo identity number in
// the agreed shape 3578{branch:02d}{role:02d}{seq:08d}: the 3578 prefix is
// retained unchanged for demo stability (historically the East Java NIK area
// head; the seeded facilities are now in Kalimantan Barat, but rotating the
// prefix would invalidate every documented demo credential), branch numbers
// the five seeded facilities in plan order
// (1 = HQ-PTK-01 .. 5 = MPOP-ARK-01), role is RoleCodeAdmin/RoleCodeVendor,
// and seq is the per-(branch,role) ordinal. Uniqueness across the plan falls
// out of the construction: no two demo accounts share a (branch, role, seq)
// triple.
func demoNIK(branch, role, seq int) string {
	return fmt.Sprintf("3578%02d%02d%08d", branch, role, seq)
}

// validSeedNIK mirrors chk_users_nik in
// migrations/000002_add_user_nik.up.sql (and its twin
// superadmin.ValidNIK): exactly 16 ASCII digits. It lives here rather than
// imported so this package keeps its single external dependency (uuid) and
// stays runnable before the module manifest exists.
func validSeedNIK(nik string) bool {
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

// SeedPlan is the complete, ordered set of rows the seeder writes. It contains
// no visit, visitor or attendance row: those are authored through the API by
// vendors and branch admins, and pre-seeding them would fabricate an audit trail.
type SeedPlan struct {
	Roles     []SeedRole
	Locations []SeedLocation
	Purposes  []SeedPurpose
	Vendors   []SeedVendor
	Users     []SeedUser
}

// ResolveLocationID returns the deterministic id of a location, or nil for the
// empty key. nil is what the users INSERT sends for super_admin and vendor, as
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
	case RoleSuperAdmin, RoleDevSuperAdmin, RoleAdmin, RoleSecurity, RoleVendor:
	default:
		return fmt.Errorf("role %q is not in chk_role_name; add its invariant to the trigger before seeding it", role)
	}
	if role == RoleDevSuperAdmin {
		if locationID != nil {
			return fmt.Errorf("role %s must have location_id = NULL, got %s", role, locationID)
		}
		if userType != UserTypeInternal {
			return fmt.Errorf("role %s must be typed %s, got %q", role, UserTypeInternal, userType)
		}
		return nil
	}
	if role == RoleSuperAdmin || role == RoleVendor {
		if locationID != nil {
			return fmt.Errorf("role %s must have location_id = NULL, got %s", role, locationID)
		}
	} else if locationID == nil {
		return fmt.Errorf("role %s must be assigned to a facility, got NULL", role)
	}
	if role == RoleVendor && userType != UserTypeExternal {
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
		case RoleSuperAdmin, RoleDevSuperAdmin, RoleAdmin, RoleSecurity, RoleVendor:
		default:
			return fmt.Errorf("role %q is not in chk_role_name", r.Name)
		}
	}
	seenNIK := map[string]string{}
	for _, u := range p.Users {
		if err := CheckInvariant(u.Role, ResolveLocationID(u.LocationCode), u.Type); err != nil {
			return fmt.Errorf("user %s: %w", u.Email, err)
		}
		if u.VendorName != "" && u.Type != UserTypeExternal {
			return errors.New("user " + u.Email + ": only external staff may carry a vendor")
		}
		// The per-role NIK rule (migration 000002): admin and vendor rows must
		// carry a well-formed 16-digit number, every other role must carry
		// none. The users_nik_key UNIQUE is pre-checked here so a duplicated
		// demo number fails the dry run instead of the transaction.
		switch u.Role {
		case RoleAdmin, RoleVendor:
			if u.NIK == "" {
				return fmt.Errorf("user %s: role %s must carry a NIK", u.Email, u.Role)
			}
			if !validSeedNIK(u.NIK) {
				return fmt.Errorf("user %s: NIK %q is not 16 numeric digits", u.Email, u.NIK)
			}
			if other, clash := seenNIK[u.NIK]; clash {
				return fmt.Errorf("user %s: NIK %q is already used by %s", u.Email, u.NIK, other)
			}
			seenNIK[u.NIK] = u.Email
		default:
			if u.NIK != "" {
				return fmt.Errorf("user %s: role %s must not carry a NIK", u.Email, u.Role)
			}
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
			{Name: RoleDevSuperAdmin, Permissions: `{}`},
			{Name: RoleAdmin, Permissions: `{}`},
			{Name: RoleSecurity, Permissions: `{}`},
			{Name: RoleVendor, Permissions: `{}`},
		},

		// Facilities are verbatim from docs/5. LOCAL_DEV.md section 6.2, apart from
		// the `type` column, which takes the ERD vocabulary (pusat|cabang|pop|minipop)
		// because that is what the schema CHECK constraint enforces. The `code` is
		// the stable key the seed plan upserts on; name and address are the
		// operator-facing SSOT strings.
		Locations: []SeedLocation{
			{
				Code: "HQ-PTK-01", Name: "Kantor Pusat THC (Pontianak)", Type: LocationPusat,
				Address: "Jl. Ahmad Yani No. 45, Pontianak", City: "Pontianak", Timezone: TimezoneWIB,
			},
			{
				Code: "BR-SBS-01", Name: "Kantor Cabang Sambas", Type: LocationCabang,
				Address: "Jl. Sukaramai No. 12, Sambas", City: "Sambas", Timezone: TimezoneWIB,
			},
			{
				Code: "POP-MPW-01", Name: "POP Mempawah", Type: LocationPOP,
				Address: "Jl. Raden Kusno No. 8, Mempawah", City: "Mempawah", Timezone: TimezoneWIB,
			},
			{
				Code: "POP-SKW-01", Name: "POP Singkawang", Type: LocationPOP,
				Address: "Jl. Pahlawan No. 22, Singkawang", City: "Singkawang", Timezone: TimezoneWIB,
			},
			{
				Code: "MPOP-ARK-01", Name: "miniPOP Aruk", Type: LocationMiniPOP,
				Address: "Pos Lintas Batas Aruk, Sambas", City: "Sambas", Timezone: TimezoneWIB,
			},
		},

		// Purpose names are the product decision: Survey, Operation &
		// Maintenance, Project, Other. The codes are the stable keys; the
		// names are operator-facing labels and are not free text to be
		// shortened.
		Purposes: []SeedPurpose{
			{Code: "SURVEY", Name: "Survey"},
			{Code: "OPERATION_MAINTENANCE", Name: "Operation & Maintenance"},
			{Code: "PROJECT", Name: "Project"},
			{Code: "OTHER", Name: "Other"},
		},

		Vendors: []SeedVendor{
			{Name: "PT Lintas Fiber"},
			{Name: "PT Daya Power Mandiri"},
		},

		// Accounts are verbatim from docs/5. LOCAL_DEV.md section 6.1. The email
		// IS the login identity the QA matrix authenticates with, so these
		// strings are a contract, not sample data: changing one silently breaks
		// every documented test credential. The demo NIKs are deterministic in
		// the shape 3578{branch:02d}{role:02d}{seq:08d} (admin = 01, vendor =
		// 02); branch numbers the five facilities above in order, and seq is
		// the per-(branch,role) ordinal. The 3578 prefix predates the
		// Kalimantan Barat move and is kept as-is for demo stability.
		Users: []SeedUser{
			{
				Name: "Hendra Wijaya (Super Admin)", Email: "superadmin@transhybrid.net.id", Role: RoleSuperAdmin,
				LocationCode: "", Type: UserTypeInternal, Status: UserStatusActive, VendorName: "",
			},
			{
				Name: "Developer Superadmin", Email: "dev-superadmin@transhybrid.net.id", Role: RoleDevSuperAdmin,
				LocationCode: "", Type: UserTypeInternal, Status: UserStatusActive, VendorName: "",
			},
			{
				Name: "Agus Setiawan (Admin Kantor Pusat Pontianak)", Email: "admin1@transhybrid.net.id", Role: RoleAdmin,
				LocationCode: "HQ-PTK-01", Type: UserTypeInternal, Status: UserStatusActive, VendorName: "",
				NIK: demoNIK(1, RoleCodeAdmin, 1),
			},
			{
				Name: "Rina Kartika (Admin Cabang Sambas)", Email: "admin2@transhybrid.net.id", Role: RoleAdmin,
				LocationCode: "BR-SBS-01", Type: UserTypeInternal, Status: UserStatusActive, VendorName: "",
				NIK: demoNIK(2, RoleCodeAdmin, 2),
			},
			{
				Name: "Dedi Kurniawan (Admin POP Mempawah)", Email: "admin3@transhybrid.net.id", Role: RoleAdmin,
				LocationCode: "POP-MPW-01", Type: UserTypeInternal, Status: UserStatusActive, VendorName: "",
				NIK: demoNIK(3, RoleCodeAdmin, 3),
			},
			{
				Name: "Siti Rahayu (Admin POP Singkawang)", Email: "admin4@transhybrid.net.id", Role: RoleAdmin,
				LocationCode: "POP-SKW-01", Type: UserTypeInternal, Status: UserStatusActive, VendorName: "",
				NIK: demoNIK(4, RoleCodeAdmin, 4),
			},
			{
				Name: "Bambang Sutrisno (Admin miniPOP Aruk)", Email: "admin5@transhybrid.net.id", Role: RoleAdmin,
				LocationCode: "MPOP-ARK-01", Type: UserTypeInternal, Status: UserStatusActive, VendorName: "",
				NIK: demoNIK(5, RoleCodeAdmin, 5),
			},
			{
				Name: "Joko Susilo (Pengawas Kantor Pusat Pontianak)", Email: "security1a@transhybrid.net.id", Role: RoleSecurity,
				LocationCode: "HQ-PTK-01", Type: UserTypeInternal, Status: UserStatusActive, VendorName: "",
			},
			{
				Name: "Sutrisno Hadi (Pengawas Kantor Pusat Pontianak)", Email: "security1b@transhybrid.net.id", Role: RoleSecurity,
				LocationCode: "HQ-PTK-01", Type: UserTypeInternal, Status: UserStatusActive, VendorName: "",
			},
			{
				Name: "Rahmat Hidayat (Pengawas Cabang Sambas)", Email: "security2a@transhybrid.net.id", Role: RoleSecurity,
				LocationCode: "BR-SBS-01", Type: UserTypeInternal, Status: UserStatusActive, VendorName: "",
			},
			{
				Name: "Wahyu Saputra (Pengawas Cabang Sambas)", Email: "security2b@transhybrid.net.id", Role: RoleSecurity,
				LocationCode: "BR-SBS-01", Type: UserTypeInternal, Status: UserStatusActive, VendorName: "",
			},
			{
				Name: "Slamet Riyadi (Pengawas POP Mempawah)", Email: "security3a@transhybrid.net.id", Role: RoleSecurity,
				LocationCode: "POP-MPW-01", Type: UserTypeInternal, Status: UserStatusActive, VendorName: "",
			},
			{
				Name: "Andi Wijaya (Pengawas POP Mempawah)", Email: "security3b@transhybrid.net.id", Role: RoleSecurity,
				LocationCode: "POP-MPW-01", Type: UserTypeInternal, Status: UserStatusActive, VendorName: "",
			},
			{
				Name: "Herman Yusuf (Pengawas POP Singkawang)", Email: "security4a@transhybrid.net.id", Role: RoleSecurity,
				LocationCode: "POP-SKW-01", Type: UserTypeInternal, Status: UserStatusActive, VendorName: "",
			},
			{
				Name: "Tono Prasetyo (Pengawas POP Singkawang)", Email: "security4b@transhybrid.net.id", Role: RoleSecurity,
				LocationCode: "POP-SKW-01", Type: UserTypeInternal, Status: UserStatusActive, VendorName: "",
			},
			{
				Name: "Mulyadi Santoso (Pengawas miniPOP Aruk)", Email: "security5a@transhybrid.net.id", Role: RoleSecurity,
				LocationCode: "MPOP-ARK-01", Type: UserTypeInternal, Status: UserStatusActive, VendorName: "",
			},
			{
				Name: "Dadang Firmansyah (Pengawas miniPOP Aruk)", Email: "security5b@transhybrid.net.id", Role: RoleSecurity,
				LocationCode: "MPOP-ARK-01", Type: UserTypeInternal, Status: UserStatusActive, VendorName: "",
			},
			{
				Name: "Dimas Prasetyo (Teknisi PT Lintas Fiber)", Email: "vendor1a@transhybrid.net.id", Role: RoleVendor,
				LocationCode: "", Type: UserTypeExternal, Status: UserStatusActive, VendorName: "PT Lintas Fiber",
				NIK: demoNIK(1, RoleCodeVendor, 1),
			},
			{
				Name: "Eko Gunawan (Teknisi PT Daya Power Mandiri)", Email: "vendor1b@transhybrid.net.id", Role: RoleVendor,
				LocationCode: "", Type: UserTypeExternal, Status: UserStatusActive, VendorName: "PT Daya Power Mandiri",
				NIK: demoNIK(1, RoleCodeVendor, 2),
			},
			{
				Name: "Fajar Nugroho (Teknisi PT Lintas Fiber)", Email: "vendor2a@transhybrid.net.id", Role: RoleVendor,
				LocationCode: "", Type: UserTypeExternal, Status: UserStatusActive, VendorName: "PT Lintas Fiber",
				NIK: demoNIK(2, RoleCodeVendor, 3),
			},
			{
				Name: "Yoga Pratama (Teknisi PT Daya Power Mandiri)", Email: "vendor2b@transhybrid.net.id", Role: RoleVendor,
				LocationCode: "", Type: UserTypeExternal, Status: UserStatusActive, VendorName: "PT Daya Power Mandiri",
				NIK: demoNIK(2, RoleCodeVendor, 4),
			},
			{
				Name: "Rudi Hartono (Teknisi PT Lintas Fiber)", Email: "vendor3a@transhybrid.net.id", Role: RoleVendor,
				LocationCode: "", Type: UserTypeExternal, Status: UserStatusActive, VendorName: "PT Lintas Fiber",
				NIK: demoNIK(3, RoleCodeVendor, 5),
			},
			{
				Name: "Asep Saepudin (Teknisi PT Daya Power Mandiri)", Email: "vendor3b@transhybrid.net.id", Role: RoleVendor,
				LocationCode: "", Type: UserTypeExternal, Status: UserStatusActive, VendorName: "PT Daya Power Mandiri",
				NIK: demoNIK(3, RoleCodeVendor, 6),
			},
			{
				Name: "Budi Santoso (Teknisi PT Lintas Fiber)", Email: "vendor4a@transhybrid.net.id", Role: RoleVendor,
				LocationCode: "", Type: UserTypeExternal, Status: UserStatusActive, VendorName: "PT Lintas Fiber",
				NIK: demoNIK(4, RoleCodeVendor, 7),
			},
			{
				Name: "Irfan Maulana (Teknisi PT Daya Power Mandiri)", Email: "vendor4b@transhybrid.net.id", Role: RoleVendor,
				LocationCode: "", Type: UserTypeExternal, Status: UserStatusActive, VendorName: "PT Daya Power Mandiri",
				NIK: demoNIK(4, RoleCodeVendor, 8),
			},
			{
				Name: "Hendra Saputra (Teknisi PT Lintas Fiber)", Email: "vendor5a@transhybrid.net.id", Role: RoleVendor,
				LocationCode: "", Type: UserTypeExternal, Status: UserStatusActive, VendorName: "PT Lintas Fiber",
				NIK: demoNIK(5, RoleCodeVendor, 9),
			},
			{
				Name: "Teguh Laksmana (Teknisi PT Daya Power Mandiri)", Email: "vendor5b@transhybrid.net.id", Role: RoleVendor,
				LocationCode: "", Type: UserTypeExternal, Status: UserStatusActive, VendorName: "PT Daya Power Mandiri",
				NIK: demoNIK(5, RoleCodeVendor, 10),
			},
		},
	}
}
