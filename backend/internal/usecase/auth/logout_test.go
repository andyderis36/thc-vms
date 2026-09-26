package auth

import (
	"context"
	"testing"

	"thc-vms/backend/internal/domain"
)

func TestLogout_IsStatelessNoOp(t *testing.T) {
	users := &fakeUsers{byEmail: map[string]domain.User{}, byID: map[domain.UUID]domain.User{}}
	svc := NewService(loginDeps(users))

	if err := svc.Logout(context.Background()); err != nil {
		t.Fatalf("Logout: %v", err)
	}
}
