package seeddata

import (
	"regexp"
	"testing"
)

// demoNIKShape is the agreed demo identity layout:
// 3578{branch:02d}{role:02d}{seq:08d} (admin = 01, vendor = 02).
var demoNIKShape = regexp.MustCompile(`^3578[0-9]{12}$`)

// TestPlanNIKsFollowTheDemoShape pins the 27-account identity contract: the
// superadmin plus five admins carry the documented population (admins with a
// NIK), the hidden dev-superadmin and the ten security (Pengawas) accounts
// carry none, and the ten vendors carry one each — every populated value 16
// digits and unique across the plan.
func TestPlanNIKsFollowTheDemoShape(t *testing.T) {
	p := Plan()
	if len(p.Users) != 27 {
		t.Fatalf("users = %d, want 27", len(p.Users))
	}
	seen := map[string]string{}
	populated := 0
	for _, u := range p.Users {
		switch u.Role {
		case RoleAdmin, RoleVendor:
			if u.NIK == "" {
				t.Errorf("user %s (role %s): missing demo NIK", u.Email, u.Role)
				continue
			}
			if !demoNIKShape.MatchString(u.NIK) {
				t.Errorf("user %s: NIK %q breaks the 3578{branch:02d}{role:02d}{seq:08d} shape", u.Email, u.NIK)
			}
			if !validSeedNIK(u.NIK) {
				t.Errorf("user %s: NIK %q fails the chk_users_nik twin", u.Email, u.NIK)
			}
			if other, clash := seen[u.NIK]; clash {
				t.Errorf("user %s: NIK %q already used by %s", u.Email, u.NIK, other)
			}
			seen[u.NIK] = u.Email
			populated++
		default:
			if u.NIK != "" {
				t.Errorf("user %s (role %s): must not carry a NIK, got %q", u.Email, u.Role, u.NIK)
			}
		}
	}
	if populated != 15 {
		t.Errorf("populated NIKs = %d, want 15 (5 admin + 10 vendor)", populated)
	}
}

// TestPlanRoleCensus locks the 27-account composition docs/5. LOCAL_DEV.md
// 6.1 publishes: one superadmin, one hidden dev-superadmin, one admin plus
// two security (Pengawas) accounts per facility, and two vendors per
// facility index.
func TestPlanRoleCensus(t *testing.T) {
	counts := map[string]int{}
	branchAdmins := map[string]int{}
	branchSecurity := map[string]int{}
	vendorA, vendorB := 0, 0
	for _, u := range Plan().Users {
		counts[u.Role]++
		switch u.Role {
		case RoleAdmin:
			branchAdmins[u.LocationCode]++
		case RoleSecurity:
			branchSecurity[u.LocationCode]++
		case RoleVendor:
			switch u.VendorName {
			case "PT Lintas Fiber":
				vendorA++
			case "PT Daya Power Mandiri":
				vendorB++
			default:
				t.Errorf("user %s: unexpected vendor %q", u.Email, u.VendorName)
			}
			if u.LocationCode != "" {
				t.Errorf("user %s: vendor must not carry a location", u.Email)
			}
		}
	}
	if counts[RoleSuperAdmin] != 1 || counts[RoleDevSuperAdmin] != 1 || counts[RoleAdmin] != 5 || counts[RoleSecurity] != 10 || counts[RoleVendor] != 10 {
		t.Fatalf("role census = %v, want 1 super_admin + 1 dev-superadmin + 5 admin + 10 security + 10 vendor", counts)
	}
	for _, l := range Plan().Locations {
		if branchAdmins[l.Code] != 1 {
			t.Errorf("facility %s: %d admins, want 1", l.Code, branchAdmins[l.Code])
		}
		if branchSecurity[l.Code] != 2 {
			t.Errorf("facility %s: %d pengawas, want 2", l.Code, branchSecurity[l.Code])
		}
	}
	if vendorA != 5 || vendorB != 5 {
		t.Errorf("vendors = %d A + %d B, want 5 + 5", vendorA, vendorB)
	}
}

// TestValidateRefusesBadNIKs proves the pre-flight pass rejects every NIK
// row the chk_users_nik CHECK or the users_nik_key UNIQUE would refuse.
func TestValidateRefusesBadNIKs(t *testing.T) {
	base := Plan()
	mutate := func(i int, nik string) SeedPlan {
		p := base
		p.Users = append([]SeedUser(nil), base.Users...)
		p.Users[i] = base.Users[i]
		p.Users[i].NIK = nik
		return p
	}
	adminIdx, vendorIdx, securityIdx := -1, -1, -1
	for i, u := range base.Users {
		switch {
		case u.Role == RoleAdmin && adminIdx < 0:
			adminIdx = i
		case u.Role == RoleVendor && vendorIdx < 0:
			vendorIdx = i
		case u.Role == RoleSecurity && securityIdx < 0:
			securityIdx = i
		}
	}
	for _, tc := range []struct {
		name string
		plan SeedPlan
	}{
		{"admin without NIK", mutate(adminIdx, "")},
		{"admin with short NIK", mutate(adminIdx, "123")},
		{"admin with non-numeric NIK", mutate(adminIdx, "35780101000000AB")},
		{"vendor without NIK", mutate(vendorIdx, "")},
		{"vendor with long NIK", mutate(vendorIdx, "35780102000000011")},
		{"pengawas with NIK", mutate(securityIdx, "3578010100000001")},
		{"duplicated NIK", mutate(vendorIdx, base.Users[adminIdx].NIK)},
	} {
		if err := Validate(tc.plan); err == nil {
			t.Errorf("%s: Validate accepted a row the database would reject", tc.name)
		}
	}
}
