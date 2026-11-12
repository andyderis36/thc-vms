package notification

import (
	"context"
	"errors"
	"testing"

	"thc-vms/backend/internal/domain"
)

type fakeNotificationRepo struct {
	last domain.NotificationFilter
}

func (f *fakeNotificationRepo) List(_ context.Context, filter domain.NotificationFilter) ([]domain.Notification, int64, int64, error) {
	f.last = filter
	return nil, 0, 0, nil
}

func (f *fakeNotificationRepo) MarkRead(_ context.Context, _, _ domain.UUID) (bool, error) {
	return true, nil
}

func (f *fakeNotificationRepo) MarkAllRead(_ context.Context, _ domain.UUID) (int64, error) {
	return 0, nil
}

func (f *fakeNotificationRepo) InsertForVisit(_ context.Context, _ domain.VisitRequest, _ *domain.NotificationTemplate, _ domain.NotificationSettings) error {
	return nil
}

func (f *fakeNotificationRepo) ResolveEmailRecipients(_ context.Context, _ domain.VisitRequest, _ domain.NotificationAudience) ([]string, error) {
	return nil, nil
}

func TestService_AdminScopedToOwnLocation(t *testing.T) {
	repo := &fakeNotificationRepo{}
	svc := NewService(repo)
	loc := domain.UUID("loc-A")
	actor := Actor{ID: "u1", Role: domain.RoleAdmin, LocationID: &loc}
	other := domain.UUID("loc-B")
	if _, err := svc.List(context.Background(), actor, ListNotificationsInput{Page: 1, Limit: 5, LocationID: &other}); err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if repo.last.LocationID == nil || *repo.last.LocationID != loc {
		t.Fatalf("admin not scoped to own location: got %v want %v", repo.last.LocationID, loc)
	}
}

func TestService_SuperAdminCanPassLocationID(t *testing.T) {
	repo := &fakeNotificationRepo{}
	svc := NewService(repo)
	loc := domain.UUID("loc-B")
	actor := Actor{ID: "u1", Role: domain.RoleSuperAdmin}
	if _, err := svc.List(context.Background(), actor, ListNotificationsInput{Page: 1, Limit: 5, LocationID: &loc}); err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if repo.last.LocationID == nil || *repo.last.LocationID != loc {
		t.Fatalf("super_admin location not passed: got %v want %v", repo.last.LocationID, loc)
	}
}

// Vendor is now an admitted notification reader (plan sec.9): it sees only its
// own notices, so a supplied location_id must never narrow or widen its feed.
func TestService_VendorScopedToSelf(t *testing.T) {
	repo := &fakeNotificationRepo{}
	svc := NewService(repo)
	other := domain.UUID("loc-B")
	actor := Actor{ID: "u1", Role: domain.RoleVendor}
	if _, err := svc.List(context.Background(), actor, ListNotificationsInput{Page: 1, Limit: 5, LocationID: &other}); err != nil {
		t.Fatalf("vendor should be admitted: %v", err)
	}
	if repo.last.LocationID != nil {
		t.Fatalf("vendor feed must ignore location_id: got %v", repo.last.LocationID)
	}
	if repo.last.UserID != actor.ID {
		t.Fatalf("vendor feed not self-scoped: got %v want %v", repo.last.UserID, actor.ID)
	}
}

// The notifications feed pagination contract (docs/4. openapi.yaml: default 20,
// max 100) is enforced by the usecase before the store is reached.
func TestService_ListAppliesPaginationContract(t *testing.T) {
	cases := []struct {
		name      string
		in        ListNotificationsInput
		wantPage  int
		wantLimit int
	}{
		{"missing limit defaults to 20", ListNotificationsInput{Page: 1, Limit: 0}, 1, domain.DefaultNotificationPageSize},
		{"over-max limit falls back to 20", ListNotificationsInput{Page: 1, Limit: 500}, 1, domain.DefaultNotificationPageSize},
		{"in-range limit is preserved", ListNotificationsInput{Page: 1, Limit: 10}, 1, 10},
		{"missing page defaults to 1", ListNotificationsInput{Page: 0, Limit: 10}, 1, 10},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			repo := &fakeNotificationRepo{}
			svc := NewService(repo)
			actor := Actor{ID: "u1", Role: domain.RoleVendor}
			got, err := svc.List(context.Background(), actor, tc.in)
			if err != nil {
				t.Fatalf("unexpected err: %v", err)
			}
			if got.Page != tc.wantPage || got.Limit != tc.wantLimit {
				t.Fatalf("page/limit = %d/%d, want %d/%d", got.Page, got.Limit, tc.wantPage, tc.wantLimit)
			}
		})
	}
}

// A role outside the admitted set is refused before the repository is touched.
func TestService_UnknownRoleForbidden(t *testing.T) {
	repo := &fakeNotificationRepo{}
	svc := NewService(repo)
	actor := Actor{ID: "u1", Role: domain.RoleName("outsider")}
	if _, err := svc.List(context.Background(), actor, ListNotificationsInput{}); err == nil {
		t.Fatal("out-of-scope role should be forbidden")
	}
}

// markReadZeroRowsRepo answers MarkRead with "zero rows affected", exactly what
// the real adapter returns when the id belongs to another user or does not exist.
type markReadZeroRowsRepo struct {
	fakeNotificationRepo
	lastID     domain.UUID
	lastUserID domain.UUID
}

func (f *markReadZeroRowsRepo) MarkRead(_ context.Context, id, userID domain.UUID) (bool, error) {
	f.lastID = id
	f.lastUserID = userID
	return false, nil
}

// Marking a notification the caller does not own (zero rows) must surface as a
// NOT_FOUND app error, never a silent success - so a caller can never flip or
// even confirm somebody else's notice. The user predicate handed to the store
// is the caller, never the notification owner.
func TestService_MarkReadForeignNotificationNotFound(t *testing.T) {
	repo := &markReadZeroRowsRepo{}
	svc := NewService(repo)
	actor := Actor{ID: "u1", Role: domain.RoleVendor}
	foreign := domain.UUID("notif-owned-by-someone-else")

	err := svc.MarkRead(context.Background(), actor, foreign)
	if err == nil {
		t.Fatal("marking a foreign notification should fail, not succeed")
	}
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("error should wrap domain.ErrNotFound: got %v", err)
	}
	var appErr *domain.AppError
	if !errors.As(err, &appErr) {
		t.Fatalf("error should be *domain.AppError: got %T", err)
	}
	if appErr.Status != 404 || appErr.Code != "NOT_FOUND" {
		t.Fatalf("status/code = %d/%s, want 404/NOT_FOUND", appErr.Status, appErr.Code)
	}
	if repo.lastUserID != actor.ID {
		t.Fatalf("store user guard = %v, want caller %v", repo.lastUserID, actor.ID)
	}
	if repo.lastID != foreign {
		t.Fatalf("store id = %v, want %v", repo.lastID, foreign)
	}
}
