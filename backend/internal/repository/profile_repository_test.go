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
	})
	if err != nil {
		t.Fatalf("UpdateProfile: %v", err)
	}
	if updated.Name != "Nama Baru" || updated.Phone != "081234567890" || updated.AvatarURL != avatar {
		t.Fatalf("updated profile = %+v, want the resolved values", updated)
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

	cleared, err := profiles.UpdateProfile(ctx, userID, domain.ProfileUpdate{Name: "Nama Baru"})
	if err != nil {
		t.Fatalf("UpdateProfile clearing avatar: %v", err)
	}
	if cleared.Phone != "" || cleared.AvatarURL != "" {
		t.Fatalf("cleared profile = %+v, want empty phone/avatar", cleared)
	}

	var stored pgtype.Text
	if err := pool.QueryRow(ctx, `SELECT avatar_url FROM users WHERE id = $1`, uuidArg(userID)).Scan(&stored); err != nil {
		t.Fatalf("read stored avatar_url: %v", err)
	}
	if stored.Valid {
		t.Fatalf("stored avatar_url = %q, want SQL NULL", stored.String)
	}
}
