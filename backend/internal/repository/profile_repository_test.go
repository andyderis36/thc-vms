package repository

// Self-service profile suite: UpdateProfile is the only port method that both
// mutates users and returns the joined profile row, so it is proven against the
// real scratch database like the other adapters.

import (
	"testing"

	"github.com/jackc/pgx/v5/pgtype"

	"thc-vms/backend/internal/domain"
)

// Given a stored account, when its own profile is updated, then the resolved
// name/phone/avatar are persisted, the complete joined row is returned, and a
// later FindByID sees the same values.
func TestProfileRepository_UpdateProfile(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	profiles := NewProfileRepository(pool)

	loc := seedLocation(t, pool, "Cabang Profil", "cabang")
	userID := seedUser(t, pool, seedUserParams{
		Name: "Nama Lama", Email: "profil@thc.test", Role: "admin", Location: loc, Type: "internal",
	})
	avatar := "http://localhost:9000/thc-vms-bucket/profile_photos/" + string(userID) + "/avatar.jpg"

	updated, err := profiles.UpdateProfile(ctx, userID, domain.ProfileUpdate{
		Name:      "Nama Baru",
		Phone:     "081234567890",
		AvatarURL: avatar,
		Email:     "profil@thc.test",
	})
	if err != nil {
		t.Fatalf("UpdateProfile: %v", err)
	}
	if updated.Name != "Nama Baru" || updated.Phone != "081234567890" || updated.AvatarURL != avatar {
		t.Fatalf("updated profile = %+v, want the resolved values", updated)
	}
	if updated.Email != "profil@thc.test" {
		t.Fatalf("updated email = %q, want the stored address passed back through", updated.Email)
	}
	if updated.LocationID == nil || *updated.LocationID != loc {
		t.Fatalf("updated location = %+v, want %s", updated.LocationID, loc)
	}

	found, err := NewUserRepository(pool).FindByID(ctx, userID)
	if err != nil {
		t.Fatalf("FindByID after update: %v", err)
	}
	if found.Name != "Nama Baru" || found.Phone != "081234567890" || found.AvatarURL != avatar {
		t.Fatalf("FindByID = %+v, want the updated profile", found)
	}

	cleared, err := profiles.UpdateProfile(ctx, userID, domain.ProfileUpdate{Name: "Nama Baru", Email: "profil@thc.test"})
	if err != nil {
		t.Fatalf("UpdateProfile clearing avatar: %v", err)
	}
	if cleared.Phone != "" || cleared.AvatarURL != "" {
		t.Fatalf("cleared profile = %+v, want empty phone/avatar", cleared)
	}

	flipped, err := profiles.UpdateProfile(ctx, userID, domain.ProfileUpdate{Name: "Nama Baru", Email: "profil-baru@thc.test"})
	if err != nil {
		t.Fatalf("UpdateProfile flipping email: %v", err)
	}
	if flipped.Email != "profil-baru@thc.test" {
		t.Fatalf("flipped email = %q, want the new address", flipped.Email)
	}
	if _, err := NewUserRepository(pool).FindByEmail(ctx, "profil-baru@thc.test"); err != nil {
		t.Fatalf("FindByEmail after flip: %v", err)
	}

	var stored pgtype.Text
	if err := pool.QueryRow(ctx, `SELECT avatar_url FROM users WHERE id = $1`, uuidArg(userID)).Scan(&stored); err != nil {
		t.Fatalf("read stored avatar_url: %v", err)
	}
	if stored.Valid {
		t.Fatalf("stored avatar_url = %q, want SQL NULL", stored.String)
	}
}

// Given a stored account, when its own password rotates through UpdateProfile,
// then the bcrypt hash changes while the profile fields stay intact; a
// rotation with an empty hash keeps the stored hash.
func TestProfileRepository_UpdateProfilePasswordRotation(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	profiles := NewProfileRepository(pool)

	loc := seedLocation(t, pool, "Cabang Sandi", "cabang")
	userID := seedUser(t, pool, seedUserParams{
		Name: "Pemegang Sandi", Email: "sandi@thc.test", Role: "admin", Location: loc, Type: "internal",
	})

	var before string
	if err := pool.QueryRow(ctx, `SELECT password_hash FROM users WHERE id = $1`, uuidArg(userID)).Scan(&before); err != nil {
		t.Fatalf("read stored password_hash: %v", err)
	}

	rotated, err := profiles.UpdateProfile(ctx, userID, domain.ProfileUpdate{
		Name:         "Pemegang Sandi",
		Phone:        "081234567890",
		Email:        "sandi@thc.test",
		PasswordHash: "$2a$10$rotatedhashfortestpurposesonly0000000000000000000000",
	})
	if err != nil {
		t.Fatalf("UpdateProfile rotating password: %v", err)
	}
	if rotated.Name != "Pemegang Sandi" || rotated.Phone != "081234567890" {
		t.Fatalf("rotated profile = %+v, want intact fields", rotated)
	}
	var after string
	if err := pool.QueryRow(ctx, `SELECT password_hash FROM users WHERE id = $1`, uuidArg(userID)).Scan(&after); err != nil {
		t.Fatalf("read rotated password_hash: %v", err)
	}
	if after == before {
		t.Fatal("stored password_hash unchanged after rotation")
	}

	if _, err := profiles.UpdateProfile(ctx, userID, domain.ProfileUpdate{
		Name:  "Pemegang Sandi",
		Phone: "081234567890",
		Email: "sandi@thc.test",
	}); err != nil {
		t.Fatalf("UpdateProfile keeping password: %v", err)
	}
	var kept string
	if err := pool.QueryRow(ctx, `SELECT password_hash FROM users WHERE id = $1`, uuidArg(userID)).Scan(&kept); err != nil {
		t.Fatalf("read kept password_hash: %v", err)
	}
	if kept != after {
		t.Fatal("stored password_hash changed without a rotation")
	}
}
