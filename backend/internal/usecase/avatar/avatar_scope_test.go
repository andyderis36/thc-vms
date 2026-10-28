package avatar_test

import (
	"context"
	"errors"
	"testing"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/avatar"
)

// TestResolveAvatarStream_ScopeMatrix pins the fail-closed read scope: self,
// super_admin and same-branch callers succeed; every other combination is the
// same 404 and never reaches storage.
func TestResolveAvatarStream_ScopeMatrix(t *testing.T) {
	cases := []struct {
		name   string
		actor  avatar.Actor
		target domain.User
		allow  bool
	}{
		{
			name:   "self allowed",
			actor:  avatar.Actor{ID: targetID, Role: domain.RoleVendor},
			target: imageTarget(),
			allow:  true,
		},
		{
			name:   "super_admin allowed",
			actor:  avatar.Actor{ID: actorID, Role: domain.RoleSuperAdmin},
			target: imageTarget(),
			allow:  true,
		},
		{
			name:   "same location allowed",
			actor:  avatar.Actor{ID: actorID, Role: domain.RoleAdmin, LocationID: &locA},
			target: withLocation(imageTarget(), &locA),
			allow:  true,
		},
		{
			name:   "different location 404",
			actor:  avatar.Actor{ID: actorID, Role: domain.RoleAdmin, LocationID: &locB},
			target: withLocation(imageTarget(), &locA),
			allow:  false,
		},
		{
			name:   "vendor cross-user 404",
			actor:  avatar.Actor{ID: otherID, Role: domain.RoleVendor},
			target: imageTarget(),
			allow:  false,
		},
		{
			name:   "nil-location target for admin 404",
			actor:  avatar.Actor{ID: actorID, Role: domain.RoleAdmin, LocationID: &locA},
			target: imageTarget(),
			allow:  false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			objects := successObjects(&trackingBody{})
			svc := newService(usersWith(tc.target), objects)

			_, err := svc.ResolveAvatarStream(context.Background(), tc.actor, tc.target.ID)

			if tc.allow {
				if err != nil {
					t.Fatalf("ResolveAvatarStream: %v", err)
				}
				return
			}
			if !errors.Is(err, domain.ErrNotFound) {
				t.Fatalf("error = %v, want ErrNotFound", err)
			}
			if objects.keyCalls != 0 || objects.openCalls != 0 {
				t.Fatalf("storage touched on a refused read: key calls %d, open calls %d", objects.keyCalls, objects.openCalls)
			}
		})
	}
}

func withLocation(user domain.User, locationID *domain.UUID) domain.User {
	user.LocationID = locationID
	return user
}
