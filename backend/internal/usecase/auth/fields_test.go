package auth

import (
	"slices"
	"testing"

	"thc-vms/backend/internal/domain"
)

// TestEditableFields_PolicyMatrix pins the single role policy table: every role
// may edit phone and avatar, and only super_admin may edit its own name.
func TestEditableFields_PolicyMatrix(t *testing.T) {
	cases := []struct {
		role  domain.RoleName
		field string
		want  bool
	}{
		{domain.RoleSuperAdmin, FieldName, true},
		{domain.RoleSuperAdmin, FieldPhone, true},
		{domain.RoleSuperAdmin, FieldAvatarURL, true},
		{domain.RoleAdmin, FieldName, false},
		{domain.RoleAdmin, FieldPhone, true},
		{domain.RoleAdmin, FieldAvatarURL, true},
		{domain.RoleSecurity, FieldName, false},
		{domain.RoleSecurity, FieldPhone, true},
		{domain.RoleSecurity, FieldAvatarURL, true},
		{domain.RoleVendor, FieldName, false},
		{domain.RoleVendor, FieldPhone, true},
		{domain.RoleVendor, FieldAvatarURL, true},
	}
	for _, tc := range cases {
		got := slices.Contains(EditableFields(tc.role), tc.field)
		if got != tc.want {
			t.Errorf("role %q field %q editable = %v, want %v", tc.role, tc.field, got, tc.want)
		}
	}
}

// TestEditableFields_ReturnsCopy proves callers cannot mutate the policy table.
func TestEditableFields_ReturnsCopy(t *testing.T) {
	first := EditableFields(domain.RoleSuperAdmin)
	first[0] = "hacked"
	second := EditableFields(domain.RoleSuperAdmin)
	if slices.Contains(second, "hacked") {
		t.Fatal("EditableFields leaked its backing slice")
	}
	if len(second) != 3 {
		t.Fatalf("fields = %v, want the three super_admin fields", second)
	}
}

// TestEditableFields_UnknownRoleFailsClosed pins that an unknown role may edit
// nothing rather than inheriting the common phone/avatar set.
func TestEditableFields_UnknownRoleFailsClosed(t *testing.T) {
	if got := EditableFields(domain.RoleName("owner")); len(got) != 0 {
		t.Fatalf("unknown role fields = %v, want none", got)
	}
}
