package repository

import (
	"testing"

	"thc-vms/backend/internal/domain"
)

// Given a stored account, when it is read back through the login query, then
// RoleID MUST be populated. The JWT directory and the auth profile projection
// both resolve a role from its id, so a user row that arrives without one makes
// every login fail with 401 at token-minting time. This test exists because the
// column was once absent from the query: every unit test passed (the usecase
// used fakes) while the real login path was broken end to end.
func TestFindByEmail_PopulatesRoleIDForTokenMinting(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)

	locationID := seedLocation(t, pool, "HQ-SBY-01", "pusat")
	seedUser(t, pool, seedUserParams{
		Name:     "Bayu Santoso",
		Email:    "admin.sby@thc.net.id",
		Role:     "admin",
		Location: locationID,
		Type:     "internal",
	})
	adminRoleID := roleIDOf(t, pool, "admin")

	repo := NewUserRepository(pool)
	user, err := repo.FindByEmail(testContext(t), "admin.sby@thc.net.id")
	if err != nil {
		t.Fatalf("FindByEmail must succeed: %v", err)
	}

	if user.RoleID == "" {
		t.Fatal("FindByEmail returned an empty RoleID: token minting and the profile projection would both fail")
	}
	if user.RoleID != adminRoleID {
		t.Fatalf("RoleID = %q, want the seeded admin role id %q", user.RoleID, adminRoleID)
	}
	if user.LocationID == nil || *user.LocationID != locationID {
		t.Fatalf("LocationID = %v, want the seeded branch %q", user.LocationID, locationID)
	}
	if user.PasswordHash == "" {
		t.Fatal("PasswordHash must be populated for the bcrypt comparison to run")
	}
}

// The same contract applies to the profile read behind GET /auth/me.
func TestFindByID_PopulatesRoleID(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)

	locationID := seedLocation(t, pool, "HQ-SBY-01", "pusat")
	userID := seedUser(t, pool, seedUserParams{
		Name:     "Joko Susilo",
		Email:    "security.sby@thc.net.id",
		Role:     "security",
		Location: locationID,
		Type:     "internal",
	})

	repo := NewUserRepository(pool)
	user, err := repo.FindByID(testContext(t), userID)
	if err != nil {
		t.Fatalf("FindByID must succeed: %v", err)
	}
	if user.RoleID != roleIDOf(t, pool, "security") {
		t.Fatalf("RoleID = %q, want the seeded security role id", user.RoleID)
	}
	if user.RoleID == domain.UUID("") {
		t.Fatal("RoleID must never be empty on a stored account")
	}
}
