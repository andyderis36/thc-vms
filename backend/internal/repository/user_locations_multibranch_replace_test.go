package repository

import (
	"testing"

	"thc-vms/backend/internal/domain"
)

// Multi-branch replace skew: PATCH /users/:id with LocationIDs [A B] must land
// the FULL union beside the kept primary in the same transaction. The skew
// suite beside this file pins only single-branch create/move/keep; the
// updateUnion patch-union branch (delete-then-insert of the carried union)
// had no repository-level pin, so a partial write could strand the coverage
// on the old single branch while the echo claimed the union.
func TestUserRepository_DualWrite_MultiBranchReplace(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	managed := NewManagedUserRepository(pool)
	users := NewUserRepository(pool)

	locA := seedLocation(t, pool, "Cabang Ganda A", "cabang")
	locB := seedLocation(t, pool, "Cabang Ganda B", "pop")
	created, err := managed.CreateManagedUser(ctx, domain.User{
		Name: "Admin Ganda", Email: "ganda@thc.test", PasswordHash: "hash-ganda",
		Phone: "0818", NIK: "3578010100000004",
		RoleID: roleIDOf(t, pool, "admin"), LocationID: &locA,
		Type: domain.UserTypeInternal, Status: domain.UserStatusActive,
	})
	if err != nil {
		t.Fatalf("CreateManagedUser: %v", err)
	}

	union := []domain.UUID{locA, locB}
	updated, err := managed.UpdateManagedUser(ctx, created.ID, domain.ManagedUserPatch{LocationIDs: union})
	if err != nil {
		t.Fatalf("UpdateManagedUser multi-branch: %v", err)
	}
	if asSet(updated.LocationIDs)[locA] != true || asSet(updated.LocationIDs)[locB] != true || len(updated.LocationIDs) != 2 {
		t.Fatalf("echo union = %v, want exactly [A B]", updated.LocationIDs)
	}
	if updated.LocationID == nil || *updated.LocationID != locA {
		t.Fatalf("echo primary = %v, want the kept branch A", updated.LocationID)
	}

	stored, err := users.FindByID(ctx, created.ID)
	if err != nil {
		t.Fatalf("FindByID: %v", err)
	}
	if stored.LocationID == nil || *stored.LocationID != locA {
		t.Fatalf("stored primary = %v, want the kept branch A", stored.LocationID)
	}
	rows, err := users.(domain.UserLocationRepository).ListUserLocationIDs(ctx, created.ID)
	if err != nil {
		t.Fatalf("ListUserLocationIDs: %v", err)
	}
	got := asSet(rows)
	if len(got) != 2 || !got[locA] || !got[locB] {
		t.Fatalf("stored coverage = %v, want exactly {A B}: skew between primary and union", rows)
	}
}

func asSet(ids []domain.UUID) map[domain.UUID]bool {
	out := make(map[domain.UUID]bool, len(ids))
	for _, id := range ids {
		out[id] = true
	}
	return out
}
