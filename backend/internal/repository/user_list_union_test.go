package repository

// RED: list reads fabricate [primary] instead of the stored branch union.
// Creating an admin with primary A + union [A,B] stores 2 join rows, but
// ListManagedUsers / ListSecurityUsers / FindManagedByID echo only [A].

import (
	"testing"

	"thc-vms/backend/internal/domain"
)

func mustUUIDs(ids ...domain.UUID) []domain.UUID { return ids }

// TestUserRepository_ListReads_ReturnStoredUnion pins the display bug: the
// union written at create time must come back on every list/detail read.
func TestUserRepository_ListReads_ReturnStoredUnion(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	managed := NewManagedUserRepository(pool)
	users := NewUserRepository(pool)

	locA := seedLocation(t, pool, "Cabang Union A", "cabang")
	locB := seedLocation(t, pool, "Cabang Union B", "pop")

	created, err := managed.CreateManagedUser(ctx, domain.User{
		Name: "Admin Union", Email: "union@thc.test", PasswordHash: "hash-union",
		Phone: "0819", NIK: "3578010100000009",
		RoleID: roleIDOf(t, pool, "admin"), LocationID: &locA,
		LocationIDs: mustUUIDs(locA, locB),
		Type:        domain.UserTypeInternal, Status: domain.UserStatusActive,
	})
	if err != nil {
		t.Fatalf("CreateManagedUser: %v", err)
	}
	if len(created.LocationIDs) != 2 {
		t.Fatalf("create echo union = %v, want [A B]", created.LocationIDs)
	}

	listed, err := managed.ListManagedUsers(ctx, domain.UserFilter{})
	if err != nil {
		t.Fatalf("ListManagedUsers: %v", err)
	}
	if len(listed) != 1 {
		t.Fatalf("ListManagedUsers rows = %d, want 1", len(listed))
	}
	got := listed[0].User.LocationIDs
	if len(got) != 2 || got[0] != locA || got[1] != locB {
		t.Fatalf("ListManagedUsers union = %v, want [%s %s]", got, locA, locB)
	}

	detail, err := managed.FindManagedByID(ctx, created.ID)
	if err != nil {
		t.Fatalf("FindManagedByID: %v", err)
	}
	got = detail.User.LocationIDs
	if len(got) != 2 || got[0] != locA || got[1] != locB {
		t.Fatalf("FindManagedByID union = %v, want [%s %s]", got, locA, locB)
	}

	sec, err := users.Create(ctx, domain.User{
		Name: "Pengawas Union", Email: "secunion@thc.test", PasswordHash: "hash-sec",
		Phone: "0820", RoleID: roleIDOf(t, pool, "security"), LocationID: &locA,
		LocationIDs: mustUUIDs(locA, locB),
		Type:        domain.UserTypeInternal, Status: domain.UserStatusActive,
	})
	if err != nil {
		t.Fatalf("Create security: %v", err)
	}
	_ = sec
	staff, err := users.ListSecurity(ctx, nil, true)
	if err != nil {
		t.Fatalf("ListSecurity: %v", err)
	}
	found := false
	for _, u := range staff {
		if u.Email == "secunion@thc.test" {
			found = true
			if len(u.LocationIDs) != 2 || u.LocationIDs[0] != locA || u.LocationIDs[1] != locB {
				t.Fatalf("ListSecurity union = %v, want [%s %s]", u.LocationIDs, locA, locB)
			}
		}
	}
	if !found {
		t.Fatalf("ListSecurity missing secunion row")
	}
}

// TestUserRepository_ListReads_LegacyFallback pins the zero-coverage-row
// path: a pre-backfill row with no user_locations entries still lists as
// [primary], never null.
func TestUserRepository_ListReads_LegacyFallback(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	managed := NewManagedUserRepository(pool)

	locA := seedLocation(t, pool, "Cabang Warisan A", "cabang")
	id := seedUser(t, pool, seedUserParams{
		Name: "Admin Warisan", Email: "warisan@thc.test", Role: "admin",
		Location: locA, Type: "internal",
	})

	listed, err := managed.ListManagedUsers(ctx, domain.UserFilter{})
	if err != nil {
		t.Fatalf("ListManagedUsers: %v", err)
	}
	if len(listed) != 1 {
		t.Fatalf("ListManagedUsers rows = %d, want 1", len(listed))
	}
	got := listed[0].User.LocationIDs
	if got == nil {
		t.Fatalf("ListManagedUsers union is nil, want [%s]", locA)
	}
	if len(got) != 1 || got[0] != locA {
		t.Fatalf("ListManagedUsers union = %v, want [%s]", got, locA)
	}

	detail, err := managed.FindManagedByID(ctx, id)
	if err != nil {
		t.Fatalf("FindManagedByID: %v", err)
	}
	if len(detail.User.LocationIDs) != 1 || detail.User.LocationIDs[0] != locA {
		t.Fatalf("FindManagedByID union = %v, want [%s]", detail.User.LocationIDs, locA)
	}
}
