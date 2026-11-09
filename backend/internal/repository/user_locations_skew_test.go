package repository

// Skew suite: users.location_id (primary) and user_locations (coverage) must
// always agree after every account write. The scope resolver reads only the
// join table while every listing reads only the primary, so any write that
// moves one store without the other in the same transaction silently forks
// the branch union from the displayed assignment. Each test below pins one
// write path; the failed-move test additionally proves atomicity (a rejected
// move leaves BOTH stores on the old branch, never a half-moved row).

import (
	"context"
	"testing"

	"thc-vms/backend/internal/domain"
)

// sameLocationPtr reports whether two optional branch ids name the same
// branch: both nil, or both set to the same id.
func sameLocationPtr(a, b *domain.UUID) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// assertCoverageAgree fails unless the primary assignment and the coverage
// union of one user are the same set: exactly one join row equal to a
// non-nil primary, or no rows beside a nil primary.
func assertCoverageAgree(t *testing.T, users domain.UserRepository, ctx context.Context, id domain.UUID, wantPrimary *domain.UUID) {
	t.Helper()
	stored, err := users.FindByID(ctx, id)
	if err != nil {
		t.Fatalf("FindByID: %v", err)
	}
	if !sameLocationPtr(stored.LocationID, wantPrimary) {
		t.Fatalf("primary location = %v, want %v", stored.LocationID, wantPrimary)
	}
	union, err := users.(domain.UserLocationRepository).ListUserLocationIDs(ctx, id)
	if err != nil {
		t.Fatalf("ListUserLocationIDs: %v", err)
	}
	switch {
	case wantPrimary == nil:
		if len(union) != 0 {
			t.Fatalf("coverage union = %v, want no rows beside a nil primary", union)
		}
	default:
		if len(union) != 1 || union[0] != *wantPrimary {
			t.Fatalf("coverage union = %v, want exactly [%s]", union, *wantPrimary)
		}
	}
}

// TestUserRepository_DualWrite_SecurityCreate pins the security-account
// create: the primary assignment and the coverage union agree from birth.
func TestUserRepository_DualWrite_SecurityCreate(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	users := NewUserRepository(pool)

	locA := seedLocation(t, pool, "Cabang Dual A", "cabang")
	created, err := users.Create(ctx, domain.User{
		Name: "Pengawas Dual", Email: "dual@thc.test", PasswordHash: "hash-dual",
		Phone: "0812", RoleID: roleIDOf(t, pool, "security"), LocationID: &locA,
		Type: domain.UserTypeInternal, Status: domain.UserStatusActive,
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	assertCoverageAgree(t, users, ctx, created.ID, &locA)
}

// TestUserRepository_DualWrite_ManagedCreate pins POST /users: an admin
// create lands on its branch in both stores, while a vendor create (nil
// primary) leaves the union empty instead of writing a NULL row.
func TestUserRepository_DualWrite_ManagedCreate(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	managed := NewManagedUserRepository(pool)

	locA := seedLocation(t, pool, "Cabang Kelola A", "cabang")
	admin, err := managed.CreateManagedUser(ctx, domain.User{
		Name: "Admin Dual", Email: "admindual@thc.test", PasswordHash: "hash-dual",
		Phone: "0813", NIK: "3578010100000001",
		RoleID: roleIDOf(t, pool, "admin"), LocationID: &locA,
		Type: domain.UserTypeInternal, Status: domain.UserStatusActive,
	})
	if err != nil {
		t.Fatalf("CreateManagedUser admin: %v", err)
	}
	assertCoverageAgree(t, NewUserRepository(pool), ctx, admin.ID, &locA)

	vendor, err := managed.CreateManagedUser(ctx, domain.User{
		Name: "Vendor Dual", Email: "vendorddual@thc.test", PasswordHash: "hash-dual",
		Phone: "0814", NIK: "3578010100000002",
		RoleID: roleIDOf(t, pool, "vendor"),
		Type: domain.UserTypeExternal, Status: domain.UserStatusActive,
	})
	if err != nil {
		t.Fatalf("CreateManagedUser vendor: %v", err)
	}
	assertCoverageAgree(t, NewUserRepository(pool), ctx, vendor.ID, nil)
}

// TestUserRepository_DualWrite_SecurityMove pins PATCH /users/security/:id:
// moving a security account replaces the old coverage row with the new
// branch in the same transaction, never appending a second row.
func TestUserRepository_DualWrite_SecurityMove(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	users := NewUserRepository(pool)
	managed := NewManagedUserRepository(pool)

	locA := seedLocation(t, pool, "Cabang Pindah A", "cabang")
	locB := seedLocation(t, pool, "Cabang Pindah B", "pop")
	created, err := users.Create(ctx, domain.User{
		Name: "Pengawas Pindah", Email: "pindah@thc.test", PasswordHash: "hash-pindah",
		Phone: "0815", RoleID: roleIDOf(t, pool, "security"), LocationID: &locA,
		Type: domain.UserTypeInternal, Status: domain.UserStatusActive,
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := managed.UpdateManagedUser(ctx, created.ID, domain.ManagedUserPatch{LocationID: &locB}); err != nil {
		t.Fatalf("UpdateManagedUser move: %v", err)
	}
	assertCoverageAgree(t, users, ctx, created.ID, &locB)
}

// TestUserRepository_DualWrite_UpdateKeep pins the partial-edit path: a
// PATCH that carries no location_id keeps the stored branch in both stores.
func TestUserRepository_DualWrite_UpdateKeep(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	managed := NewManagedUserRepository(pool)

	locA := seedLocation(t, pool, "Cabang Tetap A", "cabang")
	admin, err := managed.CreateManagedUser(ctx, domain.User{
		Name: "Admin Tetap", Email: "tetap@thc.test", PasswordHash: "hash-tetap",
		Phone: "0816", NIK: "3578010100000003",
		RoleID: roleIDOf(t, pool, "admin"), LocationID: &locA,
		Type: domain.UserTypeInternal, Status: domain.UserStatusActive,
	})
	if err != nil {
		t.Fatalf("CreateManagedUser: %v", err)
	}
	renamed := "Admin Tetap Baru"
	if _, err := managed.UpdateManagedUser(ctx, admin.ID, domain.ManagedUserPatch{Name: &renamed}); err != nil {
		t.Fatalf("UpdateManagedUser keep: %v", err)
	}
	assertCoverageAgree(t, NewUserRepository(pool), ctx, admin.ID, &locA)
}

// TestUserRepository_DualWrite_FailedMoveRollsBack pins atomicity: a move
// to an unknown branch is rejected AND leaves both stores on the old
// branch. A delete-first-outside-tx implementation would pass the error
// check yet strand the user with no coverage row; this test fails it.
func TestUserRepository_DualWrite_FailedMoveRollsBack(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	users := NewUserRepository(pool)
	managed := NewManagedUserRepository(pool)

	locA := seedLocation(t, pool, "Cabang Utuh A", "cabang")
	created, err := users.Create(ctx, domain.User{
		Name: "Pengawas Utuh", Email: "utuh@thc.test", PasswordHash: "hash-utuh",
		Phone: "0817", RoleID: roleIDOf(t, pool, "security"), LocationID: &locA,
		Type: domain.UserTypeInternal, Status: domain.UserStatusActive,
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	assertCoverageAgree(t, users, ctx, created.ID, &locA)

	ghost := domain.UUID("11111111-1111-1111-1111-111111111111")
	if _, err := managed.UpdateManagedUser(ctx, created.ID, domain.ManagedUserPatch{LocationID: &ghost}); err == nil {
		t.Fatalf("move to an unknown branch succeeded, want a constraint error")
	}
	assertCoverageAgree(t, users, ctx, created.ID, &locA)
}
