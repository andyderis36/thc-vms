package avatar_test

import (
	"context"
	"errors"
	"io"
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/avatar"
)

const (
	actorID  = domain.UUID("11111111-1111-1111-1111-111111111111")
	targetID = domain.UUID("22222222-2222-2222-2222-222222222222")
	otherID  = domain.UUID("33333333-3333-3333-3333-333333333333")

	storedAvatar = "http://minio:9000/thc-vms-bucket/profile_photos/pending-" + string(targetID) + "/avatar.jpg"
	objectKey    = "profile_photos/pending-" + string(targetID) + "/avatar.jpg"
)

var (
	locA = domain.UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
	locB = domain.UUID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
)

// fakeUsers implements domain.UserRepository. Only FindByID is exercised by the
// read usecase; the remaining methods are unreachable and panic so a future
// call site cannot silently use a stub.
type fakeUsers struct {
	byID map[domain.UUID]domain.User
}

func (f *fakeUsers) FindByID(_ context.Context, id domain.UUID) (domain.User, error) {
	user, ok := f.byID[id]
	if !ok {
		return domain.User{}, domain.ErrNotFound
	}
	return user, nil
}

func (f *fakeUsers) FindByEmail(context.Context, string) (domain.User, error) {
	panic("fakeUsers.FindByEmail must not be called")
}

func (f *fakeUsers) Create(context.Context, domain.User) (domain.User, error) {
	panic("fakeUsers.Create must not be called")
}

func (f *fakeUsers) UpdateStatus(context.Context, domain.UUID, domain.UserStatus) error {
	panic("fakeUsers.UpdateStatus must not be called")
}

func (f *fakeUsers) UpdateLastLogin(context.Context, domain.UUID, time.Time) error {
	panic("fakeUsers.UpdateLastLogin must not be called")
}

func (f *fakeUsers) ListSecurity(context.Context, []domain.UUID, bool) ([]domain.User, error) {
	panic("fakeUsers.ListSecurity must not be called")
}

// trackingBody records whether the usecase closed it, so the content-type
// refusal can be proven not to leak the bucket connection.
type trackingBody struct {
	closed bool
}

func (b *trackingBody) Read([]byte) (int, error) { return 0, io.EOF }

func (b *trackingBody) Close() error {
	b.closed = true
	return nil
}

// fakeObjects implements domain.ObjectReader with configurable failures.
type fakeObjects struct {
	key     string
	keyErr  error
	content domain.ObjectContent
	openErr error

	keyCalls  int
	openCalls int
	lastKey   string
}

func (f *fakeObjects) ObjectKeyFromStoredURL(string) (string, error) {
	f.keyCalls++
	if f.keyErr != nil {
		return "", f.keyErr
	}
	return f.key, nil
}

func (f *fakeObjects) OpenObject(_ context.Context, key string) (domain.ObjectContent, error) {
	f.openCalls++
	f.lastKey = key
	if f.openErr != nil {
		return domain.ObjectContent{}, f.openErr
	}
	return f.content, nil
}

func newService(users *fakeUsers, objects *fakeObjects) *avatar.Service {
	return avatar.NewService(avatar.Deps{Users: users, Objects: objects})
}

func usersWith(target domain.User) *fakeUsers {
	return &fakeUsers{byID: map[domain.UUID]domain.User{target.ID: target}}
}

func imageTarget() domain.User {
	return domain.User{ID: targetID, AvatarURL: storedAvatar}
}

func successObjects(body io.ReadCloser) *fakeObjects {
	return &fakeObjects{
		key: objectKey,
		content: domain.ObjectContent{
			Content:     body,
			Size:        1234,
			ContentType: "image/jpeg",
			ModTime:     time.Date(2026, time.October, 1, 9, 0, 0, 0, time.UTC),
		},
	}
}

// TestResolveAvatarStream_BlankAvatarIsNotFound pins the missing-photo 404.
func TestResolveAvatarStream_BlankAvatarIsNotFound(t *testing.T) {
	objects := successObjects(&trackingBody{})
	svc := newService(usersWith(domain.User{ID: targetID, AvatarURL: "  "}), objects)

	_, err := svc.ResolveAvatarStream(context.Background(), avatar.Actor{ID: targetID, Role: domain.RoleVendor}, targetID)
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("error = %v, want ErrNotFound", err)
	}
	if objects.keyCalls != 0 {
		t.Fatalf("storage touched for a blank avatar: key calls %d", objects.keyCalls)
	}
}

// TestResolveAvatarStream_RejectsUnsafeKey pins the namespace guard: a reversed
// key outside profile_photos/ or carrying traversal is refused before opening.
func TestResolveAvatarStream_RejectsUnsafeKey(t *testing.T) {
	cases := []struct {
		name string
		key  string
	}{
		{name: "key without profile_photos", key: "assignment_letters/pending-" + string(targetID) + "/avatar.jpg"},
		{name: "key with traversal", key: "profile_photos/../../etc/passwd"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			objects := successObjects(&trackingBody{})
			objects.key = tc.key
			svc := newService(usersWith(imageTarget()), objects)

			_, err := svc.ResolveAvatarStream(context.Background(), avatar.Actor{ID: targetID, Role: domain.RoleVendor}, targetID)
			if !errors.Is(err, domain.ErrNotFound) {
				t.Fatalf("error = %v, want ErrNotFound", err)
			}
			if objects.openCalls != 0 {
				t.Fatalf("object opened for an unsafe key: open calls %d", objects.openCalls)
			}
		})
	}
}

// TestResolveAvatarStream_RejectsNonImageAndClosesBody pins the content-type
// allowlist and proves the opened body is closed before the 404 returns.
func TestResolveAvatarStream_RejectsNonImageAndClosesBody(t *testing.T) {
	body := &trackingBody{}
	objects := successObjects(body)
	objects.content.ContentType = "application/pdf"
	svc := newService(usersWith(imageTarget()), objects)

	_, err := svc.ResolveAvatarStream(context.Background(), avatar.Actor{ID: targetID, Role: domain.RoleVendor}, targetID)
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("error = %v, want ErrNotFound", err)
	}
	if !body.closed {
		t.Fatal("non-image body was not closed")
	}
}

// TestResolveAvatarStream_OpenNotFoundIsNotFound pins the storage-miss 404.
func TestResolveAvatarStream_OpenNotFoundIsNotFound(t *testing.T) {
	objects := successObjects(&trackingBody{})
	objects.openErr = domain.ErrNotFound
	svc := newService(usersWith(imageTarget()), objects)

	_, err := svc.ResolveAvatarStream(context.Background(), avatar.Actor{ID: targetID, Role: domain.RoleVendor}, targetID)
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("error = %v, want ErrNotFound", err)
	}
}

// TestResolveAvatarStream_SuccessReturnsServedMetadata pins the resolved stream:
// the exact key reaching storage, the size, content type, modification time and
// a stable quoted ETag.
func TestResolveAvatarStream_SuccessReturnsServedMetadata(t *testing.T) {
	body := &trackingBody{}
	objects := successObjects(body)
	svc := newService(usersWith(imageTarget()), objects)
	actor := avatar.Actor{ID: targetID, Role: domain.RoleVendor}

	stream, err := svc.ResolveAvatarStream(context.Background(), actor, targetID)
	if err != nil {
		t.Fatalf("ResolveAvatarStream: %v", err)
	}
	if stream.Content != body {
		t.Fatal("stream content is not the opened body")
	}
	if stream.Size != 1234 {
		t.Fatalf("size = %d, want 1234", stream.Size)
	}
	if stream.ContentType != "image/jpeg" {
		t.Fatalf("content type = %q, want image/jpeg", stream.ContentType)
	}
	if objects.lastKey != objectKey {
		t.Fatalf("opened key = %q, want %q", objects.lastKey, objectKey)
	}
	if len(stream.ETag) < 3 || stream.ETag[0] != '"' || stream.ETag[len(stream.ETag)-1] != '"' {
		t.Fatalf("etag = %q, want a quoted value", stream.ETag)
	}

	again, err := svc.ResolveAvatarStream(context.Background(), actor, targetID)
	if err != nil {
		t.Fatalf("ResolveAvatarStream again: %v", err)
	}
	if again.ETag != stream.ETag {
		t.Fatalf("etag is not stable: %q vs %q", stream.ETag, again.ETag)
	}
}

// TestResolveAvatarStream_EmptyActorIsUnauthorized pins the 401 precondition:
// login identity is mandatory even for one's own avatar.
func TestResolveAvatarStream_EmptyActorIsUnauthorized(t *testing.T) {
	svc := newService(usersWith(imageTarget()), successObjects(&trackingBody{}))

	_, err := svc.ResolveAvatarStream(context.Background(), avatar.Actor{Role: domain.RoleVendor}, targetID)
	if !errors.Is(err, domain.ErrUnauthorized) {
		t.Fatalf("error = %v, want ErrUnauthorized", err)
	}
}
