package handlers_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/handlers"
	"thc-vms/backend/internal/domain"
)

func TestListSecurity_AvatarURLPresignedOrNull(t *testing.T) {
	const (
		stored = "http://localhost:9000/thc-vms-bucket/profile_photos/sec-1/avatar.jpg"
		signed = "https://bucket.example/thc-vms-bucket/profile_photos/sec-1/avatar.jpg?X-Amz-Signature=abc"
	)
	cases := []struct {
		name   string
		stored string
		want   any
	}{
		{name: "avatar present is presigned", stored: stored, want: signed},
		{name: "avatar empty is null", stored: "", want: nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			user := securityUser("sec-1", "s1@thc.local", "loc-own")
			user.AvatarURL = tc.stored
			store := &fakeStorage{objectKey: "profile_photos/sec-1/avatar.jpg", presignURL: signed}

			engine := gin.New()
			engine.Use(withActor(domain.RoleSuperAdmin, ""))
			h := handlers.NewUserHandler(newStubUserStore(user), &stubMasterStore{}, "role-security").
				WithFileLinks(store, 5*time.Minute)
			engine.GET("/users/security", h.ListSecurity)

			rec := serve(engine, "GET", "/users/security", nil, "")
			mustStatus(t, rec, http.StatusOK)
			items := decodeData[[]map[string]any](t, mustSuccess(t, rec))
			if len(items) != 1 {
				t.Fatalf("expected 1 account, got %d", len(items))
			}
			if items[0]["avatar_url"] != tc.want {
				t.Fatalf("avatar_url = %v, want %v", items[0]["avatar_url"], tc.want)
			}
			if tc.stored == "" {
				if store.presignCallCount != 0 {
					t.Fatalf("empty avatar must not be presigned, calls = %d", store.presignCallCount)
				}
				return
			}
			if store.lastPresignKey != "profile_photos/sec-1/avatar.jpg" {
				t.Fatalf("presigned key = %q, want the stored object key", store.lastPresignKey)
			}
			if store.lastPresignTTL != 5*time.Minute {
				t.Fatalf("presign ttl = %s, want 5m", store.lastPresignTTL)
			}
		})
	}
}

func TestSuperAdminListUsers_AvatarURLPresignedOrNull(t *testing.T) {
	const (
		stored = "http://localhost:9000/thc-vms-bucket/profile_photos/u-1/avatar.jpg"
		signed = "https://bucket.example/thc-vms-bucket/profile_photos/u-1/avatar.jpg?X-Amz-Signature=def"
	)
	locA := "11111111-1111-1111-1111-111111111111"
	cases := []struct {
		name   string
		stored string
		want   any
	}{
		{name: "avatar present is presigned", stored: stored, want: signed},
		{name: "avatar empty is null", stored: "", want: nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			account := managedAccount("u-1", "admin@thc.local", domain.RoleAdmin, &locA)
			account.User.AvatarURL = tc.stored
			store := &fakeStorage{objectKey: "profile_photos/u-1/avatar.jpg", presignURL: signed}

			engine := gin.New()
			engine.Use(withActor(domain.RoleSuperAdmin, ""))
			h := handlers.NewSuperAdminHandler(
				newStubManagedUsers(account),
				newStubLocationAdmin(),
				newStubVisitRepos(),
				"role-admin", "role-vendor",
			).WithFileLinks(store, 5*time.Minute)
			engine.GET("/users", h.ListUsers)

			rec := serve(engine, "GET", "/users", nil, "")
			mustStatus(t, rec, http.StatusOK)
			items := decodeData[[]map[string]any](t, mustSuccess(t, rec))
			if len(items) != 1 {
				t.Fatalf("expected 1 account, got %d", len(items))
			}
			if items[0]["avatar_url"] != tc.want {
				t.Fatalf("avatar_url = %v, want %v", items[0]["avatar_url"], tc.want)
			}
			if tc.stored == "" {
				if store.presignCallCount != 0 {
					t.Fatalf("empty avatar must not be presigned, calls = %d", store.presignCallCount)
				}
				return
			}
			if store.lastPresignKey != "profile_photos/u-1/avatar.jpg" {
				t.Fatalf("presigned key = %q, want the stored object key", store.lastPresignKey)
			}
			if store.lastPresignTTL != 5*time.Minute {
				t.Fatalf("presign ttl = %s, want 5m", store.lastPresignTTL)
			}
		})
	}
}
