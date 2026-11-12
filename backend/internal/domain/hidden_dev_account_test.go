package domain

import "testing"

func TestHiddenDevAccountRolePrimaryAnyEmail(t *testing.T) {
	cases := []struct {
		role  RoleName
		email string
		want  bool
	}{
		{RoleDevSuperAdmin, "andyderispas33@gmail.com", true},
		{RoleDevSuperAdmin, "", true},
		{RoleDevSuperAdmin, DevSuperadminEmail, true},
		{RoleSuperAdmin, DevSuperadminEmail, true},
		{RoleSuperAdmin, "DEV-SUPERADMIN@TRANSHYBRID.NET.ID", true},
		{RoleSuperAdmin, "andyderispas33@gmail.com", false},
		{RoleAdmin, "andyderispas33@gmail.com", false},
	}
	for _, c := range cases {
		if got := IsHiddenDevAccount(c.role, c.email); got != c.want {
			t.Fatalf("IsHiddenDevAccount(%q, %q) = %v, want %v", c.role, c.email, got, c.want)
		}
	}
}
