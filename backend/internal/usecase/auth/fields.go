package auth

import (
	"slices"

	"thc-vms/backend/internal/domain"
)

// Field tokens are the exact strings the openapi User.editable_fields enum
// publishes; never rename them without changing that contract.
const (
	FieldName      = "name"
	FieldPhone     = "phone"
	FieldAvatarURL = "avatar_url"
)

// editableFieldsByRole is the ONE self-service policy table. super_admin may
// edit its own name; every other role may edit phone and avatar only. Both the
// Me projection and the UpdateSelf gate read it through EditableFields, so no
// role decision is scattered elsewhere.
var editableFieldsByRole = map[domain.RoleName][]string{
	domain.RoleSuperAdmin:    {FieldName, FieldPhone, FieldAvatarURL},
	domain.RoleDevSuperAdmin: {FieldName, FieldPhone, FieldAvatarURL},
	domain.RoleAdmin:         {FieldPhone, FieldAvatarURL},
	domain.RoleSecurity:      {FieldPhone, FieldAvatarURL},
	domain.RoleVendor:        {FieldPhone, FieldAvatarURL},
}

// EditableFields returns a copy of the fields the role may change on its own
// account. The copy keeps callers from mutating the policy table. An unknown
// role gets an empty list, which makes every field write fail closed.
func EditableFields(role domain.RoleName) []string {
	fields, ok := editableFieldsByRole[role]
	if !ok {
		return []string{}
	}
	out := make([]string, len(fields))
	copy(out, fields)
	return out
}

// canEdit reports whether the role may change field. It reads the same table
// as EditableFields so the gate can never drift from the advertised policy.
func canEdit(role domain.RoleName, field string) bool {
	return slices.Contains(EditableFields(role), field)
}
