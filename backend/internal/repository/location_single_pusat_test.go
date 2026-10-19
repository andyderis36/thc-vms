package repository

import (
	"testing"

	"thc-vms/backend/internal/domain"
)

// TestLocation_SinglePusatEnforced proves the partial unique index
// uq_location_single_pusat (migration 000011) rejects a second 'pusat'
// location while still allowing other types.
func TestLocation_SinglePusatEnforced(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)

	// Seed the one allowed Kantor Pusat.
	seedLocation(t, pool, "Kantor Pusat", "pusat")

	repo := NewLocationAdminRepository(pool)
	ctx := testContext(t)

	// A second 'pusat' must be rejected as a conflict carrying the specific
	// Indonesian message.
	if _, err := repo.CreateLocation(ctx, domain.Location{
		Name: "Kantor Pusat Duplikat", Type: domain.LocationPusat,
		Timezone: domain.TimezoneWIB, IsActive: true,
	}); err == nil {
		t.Fatal("second pusat must be rejected")
	} else {
		if !isConflictErr(err) {
			t.Fatalf("second pusat: got %v, want conflict", err)
		}
		appErr := domain.FromError(err)
		if appErr == nil || appErr.Code != "CONFLICT" {
			t.Fatalf("second pusat: code = %v, want CONFLICT", appErr)
		}
		if appErr.Message != "Kantor Pusat sudah terdaftar. Hanya boleh ada satu Kantor Pusat." {
			t.Fatalf("second pusat: message = %q, want specific Indonesian message", appErr.Message)
		}
	}

	// Another 'cabang' must still succeed.
	created, err := repo.CreateLocation(ctx, domain.Location{
		Name: "Cabang Baru", Type: domain.LocationCabang,
		Timezone: domain.TimezoneWIB, IsActive: true,
	})
	if err != nil {
		t.Fatalf("cabang create must succeed: %v", err)
	}
	if created.Type != domain.LocationCabang {
		t.Fatalf("created type = %s, want cabang", created.Type)
	}

	// Audited path must surface the same conflict.
	audited, ok := repo.(domain.AuditedLocationRepository)
	if !ok {
		t.Fatal("location adapter must serve the audited port")
	}
	if _, err := audited.CreateLocationAudited(ctx, domain.Location{
		Name: "Kantor Pusat Audited", Type: domain.LocationPusat,
		Timezone: domain.TimezoneWIB, IsActive: true,
	}, domain.AuditEntry{Action: domain.AuditActionLocationCreate, Entity: domain.AuditEntityLocation}); err == nil {
		t.Fatal("audited second pusat must be rejected")
	} else if !isConflictErr(err) {
		t.Fatalf("audited second pusat: got %v, want conflict", err)
	}
}

// TestLocation_UpdateToSecondPusatEnforced proves the same invariant on the
// PATCH path: promoting a facility to 'pusat' while one already exists is
// refused on both the plain and the audited write, while an ordinary rename
// of the branch still succeeds.
func TestLocation_UpdateToSecondPusatEnforced(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)

	seedLocation(t, pool, "Kantor Pusat", "pusat")
	branch := seedLocation(t, pool, "Cabang Lama", "cabang")

	repo := NewLocationAdminRepository(pool)
	ctx := testContext(t)
	pusat := domain.LocationPusat

	if _, err := repo.UpdateLocation(ctx, branch, domain.LocationPatch{Type: &pusat}); err == nil {
		t.Fatal("patching a cabang into a second pusat must be rejected")
	} else {
		requireErrIs(t, err, domain.ErrConflict, "update second pusat")
		if code := domain.FromError(err).Code; code != "CONFLICT" {
			t.Fatalf("update second pusat: code = %q, want CONFLICT", code)
		}
	}

	audited, ok := repo.(domain.AuditedLocationRepository)
	if !ok {
		t.Fatal("location adapter must serve the audited port")
	}
	if _, err := audited.UpdateLocationAudited(ctx, branch, domain.LocationPatch{Type: &pusat},
		domain.AuditEntry{Action: domain.AuditActionLocationUpdate, Entity: domain.AuditEntityLocation}); err == nil {
		t.Fatal("audited patch into a second pusat must be rejected")
	} else if !isConflictErr(err) {
		t.Fatalf("audited update second pusat: got %v, want conflict", err)
	}

	name := "Cabang Baru"
	updated, err := repo.UpdateLocation(ctx, branch, domain.LocationPatch{Name: &name})
	if err != nil {
		t.Fatalf("renaming the branch must still succeed: %v", err)
	}
	if updated.Name != name {
		t.Fatalf("renamed facility = %q, want %q", updated.Name, name)
	}
}

func isConflictErr(err error) bool {
	return domain.FromError(err) != nil && domain.FromError(err).Code == "CONFLICT"
}
