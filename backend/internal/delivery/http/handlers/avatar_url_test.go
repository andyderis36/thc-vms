package handlers_test

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/handlers"
	"thc-vms/backend/internal/domain"
)

// avatarVersion derives the expected cache-busting version the way the
// contract defines it: the first 8 hex characters of sha256(stored).
func avatarVersion(stored string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(stored)))
	return hex.EncodeToString(sum[:])[:8]
}

// assertAPIPathAvatar fails when the served avatar_url is not the API path for
// the account, or leaks any storage address.
func assertAPIPathAvatar(t *testing.T, got any, userID, stored string) {
	t.Helper()
	want := "/api/v1/avatars/" + userID + "?v=" + avatarVersion(stored)
	if got != want {
		t.Fatalf("avatar_url = %v, want %q", got, want)
	}
	for _, forbidden := range []string{"http://", "https://", "minio"} {
		if strings.Contains(got.(string), forbidden) {
			t.Fatalf("avatar_url = %v, must not contain %q", got, forbidden)
		}
	}
}

// TestListSecurity_AvatarURLIsAPIPathOrNull pins the read contract: a stored
// avatar projects onto the authenticated API path (never a presigned or raw
// bucket URL) and a blank stored value stays null.
func TestListSecurity_AvatarURLIsAPIPathOrNull(t *testing.T) {
	const stored = "http://localhost:9000/thc-vms-bucket/profile_photos/sec-1/avatar.jpg"
	cases := []struct {
		name   string
		stored string
		null   bool
	}{
		{name: "avatar present is the API path", stored: stored},
		{name: "avatar empty is null", stored: "", null: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			user := securityUser("sec-1", "s1@thc.local", "loc-own")
			user.AvatarURL = tc.stored

			engine := gin.New()
			engine.Use(withActor(domain.RoleSuperAdmin, ""))
			h := handlers.NewUserHandler(newStubUserStore(user), &stubMasterStore{}, "role-security")
			engine.GET("/users/security", h.ListSecurity)

			rec := serve(engine, "GET", "/users/security", nil, "")
			mustStatus(t, rec, http.StatusOK)
			items := decodeData[[]map[string]any](t, mustSuccess(t, rec))
			if len(items) != 1 {
				t.Fatalf("expected 1 account, got %d", len(items))
			}
			if tc.null {
				if items[0]["avatar_url"] != nil {
					t.Fatalf("avatar_url = %v, want null", items[0]["avatar_url"])
				}
				return
			}
			assertAPIPathAvatar(t, items[0]["avatar_url"], "sec-1", tc.stored)
		})
	}
}

// TestSuperAdminListUsers_AvatarURLIsAPIPathOrNull pins the same read contract
// on the super_admin console listing.
func TestSuperAdminListUsers_AvatarURLIsAPIPathOrNull(t *testing.T) {
	const stored = "http://localhost:9000/thc-vms-bucket/profile_photos/u-1/avatar.jpg"
	locA := "11111111-1111-1111-1111-111111111111"
	cases := []struct {
		name   string
		stored string
		null   bool
	}{
		{name: "avatar present is the API path", stored: stored},
		{name: "avatar empty is null", stored: "", null: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			account := managedAccount("u-1", "admin@thc.local", domain.RoleAdmin, &locA)
			account.User.AvatarURL = tc.stored

			engine := gin.New()
			engine.Use(withActor(domain.RoleSuperAdmin, ""))
			h := handlers.NewSuperAdminHandler(
				newStubManagedUsers(account),
				newStubLocationAdmin(),
				newStubLocationAdmin(),
				newStubVisitRepos(),
				"role-admin", "role-vendor",
			)
			engine.GET("/users", h.ListUsers)

			rec := serve(engine, "GET", "/users", nil, "")
			mustStatus(t, rec, http.StatusOK)
			items := decodeData[[]map[string]any](t, mustSuccess(t, rec))
			if len(items) != 1 {
				t.Fatalf("expected 1 account, got %d", len(items))
			}
			if tc.null {
				if items[0]["avatar_url"] != nil {
					t.Fatalf("avatar_url = %v, want null", items[0]["avatar_url"])
				}
				return
			}
			assertAPIPathAvatar(t, items[0]["avatar_url"], "u-1", tc.stored)
		})
	}
}
