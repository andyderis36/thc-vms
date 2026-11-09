package avatar_test

import (
	"context"
	"errors"
	"testing"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/avatar"
)

// TestResolveAvatarStream_UnionMemberAllowed pins the membership widening: an
// admin whose stashed union covers the target branch reads the avatar even
// when the scalar primary points elsewhere.
func TestResolveAvatarStream_UnionMemberAllowed(t *testing.T) {
	objects := successObjects(&trackingBody{})
	svc := newService(usersWith(withLocation(imageTarget(), &locA)), objects)
	actor := avatar.Actor{ID: actorID, Role: domain.RoleAdmin, LocationID: &locB, Branches: []domain.UUID{locA}}

	stream, err := svc.ResolveAvatarStream(context.Background(), actor, targetID)
	if err != nil {
		t.Fatalf("union member avatar read refused: %v", err)
	}
	if stream.Content == nil {
		t.Fatal("expected a resolved stream, got nil content")
	}
	if objects.openCalls != 1 {
		t.Fatalf("open calls = %d, want 1", objects.openCalls)
	}
}

// TestResolveAvatarStream_UnionNonMemberIsNotFound pins the fallback: outside
// both the union and the scalar primary, the read is the same 404 and never
// reaches storage.
func TestResolveAvatarStream_UnionNonMemberIsNotFound(t *testing.T) {
	objects := successObjects(&trackingBody{})
	svc := newService(usersWith(withLocation(imageTarget(), &locA)), objects)
	actor := avatar.Actor{ID: actorID, Role: domain.RoleAdmin, LocationID: &locB, Branches: []domain.UUID{otherID}}

	_, err := svc.ResolveAvatarStream(context.Background(), actor, targetID)
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("error = %v, want ErrNotFound", err)
	}
	if objects.keyCalls != 0 {
		t.Fatalf("storage touched for a refused read: key calls %d", objects.keyCalls)
	}
}
