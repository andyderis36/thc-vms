package seeddata

import (
	"strings"
	"testing"

	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

// wantBcryptCost is the cost factor docs/5. LOCAL_DEV.md 6 mandates. It is a
// test-local literal on purpose: asserting against SeedBcryptCost would compare
// the output with the very constant the implementation reads, which stays green
// even if the program raises the cost.
const wantBcryptCost = 10

// TestPlanCounts locks the row counts docs/5. LOCAL_DEV.md 6 specifies. A
// changed count must be a deliberate edit here, never an accident.
func TestPlanCounts(t *testing.T) {
	p := Plan()
	for _, c := range []struct {
		what string
		got  int
		want int
	}{
		{"roles", len(p.Roles), 5},
		{"locations", len(p.Locations), 5},
		{"purposes", len(p.Purposes), 4},
		{"vendors", len(p.Vendors), 2},
		{"users", len(p.Users), 27},
	} {
		if c.got != c.want {
			t.Errorf("%s: got %d rows, want %d", c.what, c.got, c.want)
		}
	}
}

// TestPlanIsValid keeps the shipped plan acceptable to the schema, so a data
// edit cannot pass the count test while being un-insertable.
func TestPlanIsValid(t *testing.T) {
	if err := Validate(Plan()); err != nil {
		t.Fatalf("shipped plan is invalid: %v", err)
	}
}

// TestEveryEmailIsUnique guards the ON CONFLICT (email) key: two demo accounts
// sharing an address would silently collapse into one row on re-run.
func TestEveryEmailIsUnique(t *testing.T) {
	seen := map[string]bool{}
	for _, u := range Plan().Users {
		if seen[u.Email] {
			t.Errorf("duplicate demo email %q", u.Email)
		}
		seen[u.Email] = true
	}
}

// TestDerivedIDsAreStableAndDistinct pins the property that makes re-running
// idempotent: the same key always yields the same uuid, and no two rows collide.
func TestDerivedIDsAreStableAndDistinct(t *testing.T) {
	p := Plan()
	seen := map[uuid.UUID]string{}
	note := func(id uuid.UUID, what string) {
		t.Helper()
		if other, clash := seen[id]; clash {
			t.Errorf("%s collides with %s on %s", what, other, id)
		}
		seen[id] = what
	}
	for _, l := range p.Locations {
		note(DeriveID(EntityLocation, l.Code), "location "+l.Code)
	}
	for _, pr := range p.Purposes {
		note(DeriveID(EntityPurpose, pr.Code), "purpose "+pr.Code)
	}
	for _, v := range p.Vendors {
		note(DeriveID(EntityVendor, v.Name), "vendor "+v.Name)
	}
	if got, want := DeriveID(EntityLocation, "HQ-PTK-01"), DeriveID(EntityLocation, "HQ-PTK-01"); got != want {
		t.Errorf("DeriveID is not deterministic: %s then %s", got, want)
	}
}

// TestLocationsUseTheSchemaVocabulary is the anti-stale-label guard: the
// documentation headings (head_office, branch_office, mini_pop) are not the
// CHECK-constraint values, and seeding one would abort the whole transaction.
func TestLocationsUseTheSchemaVocabulary(t *testing.T) {
	for _, l := range Plan().Locations {
		if !ValidLocationType(l.Type) {
			t.Errorf("location %s: type %q is not one of %s", l.Code, l.Type, strings.Join(LocationTypes(), "|"))
		}
	}
	for _, stale := range []string{"head_office", "branch_office", "mini_pop"} {
		if ValidLocationType(stale) {
			t.Errorf("stale documentation label %q is accepted as a location type", stale)
		}
	}
}

// TestRoleLocationInvariantMatrix mirrors enforce_user_location_invariant().
// Each row is one case from the plpgsql trigger, including a role it does not
// know, so an unexpected name must not be inserted.
func TestRoleLocationInvariantMatrix(t *testing.T) {
	loc := ResolveLocationID("HQ-PTK-01")
	violations := []struct {
		name     string
		role     string
		location *uuid.UUID
		userType string
	}{
		{"super_admin with a location", RoleSuperAdmin, loc, UserTypeInternal},
		{"dev-superadmin with a location", RoleDevSuperAdmin, loc, UserTypeInternal},
		{"dev-superadmin typed external", RoleDevSuperAdmin, nil, UserTypeExternal},
		{"admin without a location", RoleAdmin, nil, UserTypeInternal},
		{"security without a location", RoleSecurity, nil, UserTypeInternal},
		{"vendor with a location", RoleVendor, loc, UserTypeExternal},
		{"vendor typed internal", RoleVendor, nil, UserTypeInternal},
		{"unknown role", "superuser", loc, UserTypeInternal},
	}
	for _, v := range violations {
		if err := CheckInvariant(v.role, v.location, v.userType); err == nil {
			t.Errorf("%s: CheckInvariant(%q, %v, %q) accepted a row the trigger would reject",
				v.name, v.role, v.location, v.userType)
		}
	}

	accepted := []struct {
		name     string
		role     string
		location *uuid.UUID
		userType string
	}{
		{"super_admin is global", RoleSuperAdmin, nil, UserTypeInternal},
		{"dev-superadmin is global and internal", RoleDevSuperAdmin, nil, UserTypeInternal},
		{"admin is bound to a facility", RoleAdmin, loc, UserTypeInternal},
		{"security is bound to a facility", RoleSecurity, loc, UserTypeInternal},
		{"vendor is global and external", RoleVendor, nil, UserTypeExternal},
	}
	for _, a := range accepted {
		if err := CheckInvariant(a.role, a.location, a.userType); err != nil {
			t.Errorf("%s: CheckInvariant rejected a legal row: %v", a.name, err)
		}
	}
}

// TestShippedUsersSatisfyTheInvariant proves the demo accounts match the
// documented role/location matrix, and that every reference resolves.
func TestShippedUsersSatisfyTheInvariant(t *testing.T) {
	p := Plan()
	codes := map[string]bool{}
	for _, l := range p.Locations {
		codes[l.Code] = true
	}
	vendors := map[string]bool{}
	for _, v := range p.Vendors {
		vendors[v.Name] = true
	}
	for _, u := range p.Users {
		if err := CheckInvariant(u.Role, ResolveLocationID(u.LocationCode), u.Type); err != nil {
			t.Errorf("user %s: %v", u.Email, err)
		}
		if u.LocationCode != "" && !codes[u.LocationCode] {
			t.Errorf("user %s: references unknown location code %q", u.Email, u.LocationCode)
		}
		if u.VendorName != "" && !vendors[u.VendorName] {
			t.Errorf("user %s: references unknown vendor %q", u.Email, u.VendorName)
		}
		if (u.Type == UserTypeExternal) != (u.VendorName != "") {
			t.Errorf("user %s: type %q and vendor %q disagree", u.Email, u.Type, u.VendorName)
		}
	}
}

// TestAllSeedPasswordsVerify proves every demo account can log in with the one
// password docs/5. LOCAL_DEV.md 6.1 publishes, at the bcrypt cost factor that
// same document mandates. It reads the cost through bcrypt.Cost (the hash
// prefix) rather than string-matching a hash literal, and never compares
// against a stored hash string - only against a password.
//
// The plaintext is deliberately not written into this file, so "the hash
// verifies the published password" is anchored on DemoPassword in password.go
// (a constant a reviewer reads against the document) rather than on a second
// copy here. What this test pins independently is the cost factor, the absence
// of a plaintext row, the exact-password match, and one salt per account.
func TestAllSeedPasswordsVerify(t *testing.T) {
	users := Plan().Users

	hashes, err := HashSeedPasswords(users)
	if err != nil {
		t.Fatalf("HashSeedPasswords: %v", err)
	}

	seen := map[string]string{}
	for _, u := range users {
		hash, ok := hashes[u.Email]
		if !ok {
			t.Errorf("no password hash produced for %q", u.Email)
			continue
		}
		if hash == DemoPassword {
			t.Errorf("user %q was seeded with a plaintext password", u.Email)
			continue
		}
		cost, err := bcrypt.Cost([]byte(hash))
		if err != nil {
			t.Errorf("user %q: hash is not a bcrypt hash: %v", u.Email, err)
			continue
		}
		if cost != wantBcryptCost {
			t.Errorf("user %q: bcrypt cost %d, want %d", u.Email, cost, wantBcryptCost)
		}
		if err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(DemoPassword)); err != nil {
			t.Errorf("user %q: hash does not verify the demo password: %v", u.Email, err)
		}
		// A hash must be bound to exactly this password, not merely to
		// something that starts like it.
		if err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(DemoPassword+"!")); err == nil {
			t.Errorf("user %q: hash also verifies a different password", u.Email)
		}
		// One salt per account: identical hashes would mean the accounts share
		// a hash blob instead of holding independent credentials.
		if other, clash := seen[hash]; clash {
			t.Errorf("user %q reuses the hash of %q: every account needs its own salt", u.Email, other)
		}
		seen[hash] = u.Email
	}
}
