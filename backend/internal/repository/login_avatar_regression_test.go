package repository

import (
	"testing"
)

// storedAvatarURL is the form the profile-photo upload path persists: an
// absolute URL inside our own bucket, which the auth profile projection later
// reverses into an object key before presigning. It must never reach a client
// verbatim.
const storedAvatarURL = "http://localhost:9000/thc-vms-bucket/profile_photos/pending-user-admin-1/avatar.jpg"

// Given an account with a stored avatar, when it is read back through the login
// query, then AvatarURL MUST be populated. Login feeds that user row straight
// into the shared profile projection, which presigns AvatarURL; a row that
// arrives without it makes POST /auth/login answer avatar_url "" while
// GET /auth/me (a different query that does select the column) answers a valid
// presigned URL. This test exists because the column was once absent from the
// login projection: every usecase unit test passed against fakes while the real
// login response was broken.
func TestFindByEmail_PopulatesAvatarURLForLogin(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)

	locationID := seedLocation(t, pool, "HQ-SBY-01", "pusat")
	userID := seedUser(t, pool, seedUserParams{
		Name:     "Bayu Santoso",
		Email:    "admin.sby@thc.net.id",
		Role:     "admin",
		Location: locationID,
		Type:     "internal",
	})
	if _, err := pool.Exec(testContext(t),
		`UPDATE users SET avatar_url = $2 WHERE id = $1`,
		uuidArg(userID), storedAvatarURL); err != nil {
		t.Fatalf("store avatar url: %v", err)
	}

	repo := NewUserRepository(pool)
	user, err := repo.FindByEmail(testContext(t), "admin.sby@thc.net.id")
	if err != nil {
		t.Fatalf("FindByEmail must succeed: %v", err)
	}

	if user.AvatarURL != storedAvatarURL {
		t.Fatalf("AvatarURL = %q, want the stored %q: login would presign an empty avatar",
			user.AvatarURL, storedAvatarURL)
	}
}
