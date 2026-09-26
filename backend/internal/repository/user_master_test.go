package repository

// Account + catalogue suite: user lifecycle reads/writes and the SCR-03
// pickers. Not in the required list, but the ports are only proven when every
// method has at least one integration pass.

import (
	"testing"

	"thc-vms/backend/internal/domain"
)

// TestUserRepository_Lifecycle covers Create, both finds, status flip, login
// stamp and the branch-scoped security listing.
func TestUserRepository_Lifecycle(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	users := NewUserRepository(pool)

	locA := seedLocation(t, pool, "Cabang Akun A", "cabang")
	locB := seedLocation(t, pool, "Cabang Akun B", "pop")
	secRole := seedUser(t, pool, seedUserParams{Name: "probe", Email: "probe@thc.test", Role: "security", Location: locA, Type: "internal"})
	_ = secRole
	roleID := roleIDOf(t, pool, "security")

	created, err := users.Create(ctx, domain.User{
		Name: "Satpam Baru", Email: "baru@thc.test", PasswordHash: "hash-baru",
		Phone: "0812", RoleID: roleID, LocationID: &locA,
		Type: domain.UserTypeInternal, Status: domain.UserStatusActive,
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if created.ID == "" || created.RoleID == "" {
		t.Fatalf("created user missing id/role: %+v", created)
	}
	if created.LocationID == nil || *created.LocationID != locA {
		t.Fatalf("created location = %+v, want %s", created.LocationID, locA)
	}

	found, err := users.FindByEmail(ctx, "baru@thc.test")
	if err != nil {
		t.Fatalf("FindByEmail: %v", err)
	}
	if found.Name != "Satpam Baru" || found.Status != domain.UserStatusActive {
		t.Fatalf("found = %+v, want the created account", found)
	}
	if _, err := users.FindByEmail(ctx, "tidak-ada@thc.test"); err == nil {
		t.Fatalf("FindByEmail on missing email succeeded, want ErrNotFound")
	} else {
		requireErrIs(t, err, domain.ErrNotFound, "missing email")
	}

	byID, err := users.FindByID(ctx, created.ID)
	if err != nil {
		t.Fatalf("FindByID: %v", err)
	}
	if byID.Email != "baru@thc.test" {
		t.Fatalf("FindByID email = %s, want baru@thc.test", byID.Email)
	}

	if err := users.UpdateStatus(ctx, created.ID, domain.UserStatusInactive); err != nil {
		t.Fatalf("UpdateStatus: %v", err)
	}
	found, err = users.FindByEmail(ctx, "baru@thc.test")
	if err != nil {
		t.Fatalf("FindByEmail after status flip: %v", err)
	}
	if found.Status != domain.UserStatusInactive {
		t.Fatalf("status = %s, want inactive", found.Status)
	}

	if err := users.UpdateLastLogin(ctx, created.ID, found.CreatedAt); err != nil {
		t.Fatalf("UpdateLastLogin: %v", err)
	}

	other := seedUser(t, pool, seedUserParams{Name: "Satpam B", Email: "b@thc.test", Role: "security", Location: locB, Type: "internal"})
	_ = other
	branch, err := users.ListSecurity(ctx, &locA)
	if err != nil {
		t.Fatalf("ListSecurity branch: %v", err)
	}
	if len(branch) != 2 {
		t.Fatalf("branch security = %d, want 2 (probe + baru)", len(branch))
	}
	for _, u := range branch {
		if u.LocationID == nil || *u.LocationID != locA {
			t.Fatalf("ListSecurity leaked %+v into branch %s", u.Email, locA)
		}
	}
	all, err := users.ListSecurity(ctx, nil)
	if err != nil {
		t.Fatalf("ListSecurity all: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("all security = %d, want 3", len(all))
	}
}

// TestMasterDataRepository_Pickers covers both catalogue lists and the
// location detail read.
func TestMasterDataRepository_Pickers(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	master := NewMasterDataRepository(pool)

	loc := seedLocation(t, pool, "Cabang Katalog", "cabang")
	seedInactiveLocation(t, pool, "Cabang Mati")
	seedPurpose(t, pool, "Survei")
	seedPurpose(t, pool, "Troubleshoot")

	locations, err := master.ListLocations(ctx, true)
	if err != nil {
		t.Fatalf("ListLocations: %v", err)
	}
	if len(locations) != 1 || locations[0].ID != loc {
		t.Fatalf("active locations = %+v, want only the active branch", locations)
	}

	purposes, err := master.ListPurposes(ctx, true)
	if err != nil {
		t.Fatalf("ListPurposes: %v", err)
	}
	if len(purposes) != 2 {
		t.Fatalf("purposes = %d, want 2", len(purposes))
	}

	detail, err := master.FindLocationByID(ctx, loc)
	if err != nil {
		t.Fatalf("FindLocationByID: %v", err)
	}
	if detail.Name != "Cabang Katalog" || detail.Type != domain.LocationCabang {
		t.Fatalf("location detail = %+v", detail)
	}
}
