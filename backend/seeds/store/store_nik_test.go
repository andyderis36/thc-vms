package store

import (
	"strings"
	"testing"

	"github.com/google/uuid"

	"thc-vms/backend/seeds/seeddata"
)

// TestApplySendsNIKPerRole proves the ninth user-insert argument carries the
// identity number exactly where the plan holds one (admin, vendor) and SQL NULL
// everywhere else (super_admin, security), so chk_users_nik never sees an
// empty string.
func TestApplySendsNIKPerRole(t *testing.T) {
	session := &recordingSession{}
	if err := applyPlan(t, session); err != nil {
		t.Fatalf("Apply: %v", err)
	}

	roleOf := map[uuid.UUID]string{}
	for _, st := range session.statements {
		if !strings.Contains(strings.ToLower(st.sql), "insert into role") {
			continue
		}
		name, _ := st.args[0].(string)
		roleOf[seeddata.DeriveID(seeddata.EntityRole, name)] = name
	}

	users := 0
	for _, st := range session.statements {
		if !insertTarget.MatchString(st.sql) || !strings.Contains(strings.ToLower(st.sql), "users") {
			continue
		}
		users++
		roleID, ok := st.args[3].(uuid.UUID)
		if !ok {
			t.Fatalf("role_id arg is %T, want uuid.UUID", st.args[3])
		}
		nik, ok := st.args[8].(*string)
		if !ok {
			t.Fatalf("nik arg is %T, want *string", st.args[8])
		}
		switch roleOf[roleID] {
		case seeddata.RoleAdmin, seeddata.RoleVendor:
			if nik == nil || *nik == "" {
				t.Errorf("role %s: NIK arg is absent, want the plan digits", roleOf[roleID])
			}
		default:
			if nik != nil {
				t.Errorf("role %s: NIK arg is %q, want SQL NULL", roleOf[roleID], *nik)
			}
		}
	}
	if users != 26 {
		t.Fatalf("recorded %d user inserts, want 26", users)
	}
}
