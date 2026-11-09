package auth

import (
	"context"
	"testing"

	"thc-vms/backend/internal/domain"
)

func TestMe_ReturnsProfile(t *testing.T) {
	users := &fakeUsers{byEmail: map[string]domain.User{}, byID: map[domain.UUID]domain.User{}}
	admin := activeAdmin(hashPassword(t, "Password123!"))
	users.byEmail["admin@thc.local"] = admin
	users.byID[admin.ID] = admin
	svc := NewService(loginDeps(users))

	got, err := svc.Me(context.Background(), "user-admin-1")
	if err != nil {
		t.Fatalf("Me: %v", err)
	}
	if got.ID != "user-admin-1" {
		t.Fatalf("id = %q, want user-admin-1", got.ID)
	}
	if got.Role != domain.RoleAdmin {
		t.Fatalf("role = %q, want admin", got.Role)
	}
	if got.LocationID == nil || *got.LocationID != "loc-bandung" {
		t.Fatalf("location_id = %v, want loc-bandung", got.LocationID)
	}
	if got.LocationName == nil || *got.LocationName != "THC Cabang Bandung" {
		t.Fatalf("location_name = %v, want THC Cabang Bandung", got.LocationName)
	}
	if got.Status != domain.UserStatusActive {
		t.Fatalf("status = %q, want active", got.Status)
	}
}

func TestMe_LocationIDsCopiesUserUnion(t *testing.T) {
	users := &fakeUsers{byEmail: map[string]domain.User{}, byID: map[domain.UUID]domain.User{}}
	admin := activeAdmin(hashPassword(t, "Password123!"))
	loc2 := domain.UUID("loc-jakarta")
	admin.LocationIDs = []domain.UUID{"loc-bandung", loc2}
	users.byID[admin.ID] = admin
	svc := NewService(loginDeps(users))

	got, err := svc.Me(context.Background(), "user-admin-1")
	if err != nil {
		t.Fatalf("Me: %v", err)
	}
	if len(got.LocationIDs) != 2 || got.LocationIDs[0] != "loc-bandung" || got.LocationIDs[1] != loc2 {
		t.Fatalf("location_ids = %v, want [loc-bandung loc-jakarta]", got.LocationIDs)
	}
}

func TestMe_UserNotFound(t *testing.T) {
	users := &fakeUsers{byEmail: map[string]domain.User{}, byID: map[domain.UUID]domain.User{}}
	svc := NewService(loginDeps(users))

	_, err := svc.Me(context.Background(), "user-ghost-1")
	if err == nil {
		t.Fatal("Me succeeded for unknown id, want 404")
	}
	if got := appErrorOf(t, err); got.Code != "NOT_FOUND" {
		t.Fatalf("code = %q, want NOT_FOUND", got.Code)
	}
}
