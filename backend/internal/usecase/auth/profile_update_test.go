package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
)

const selfStorageBase = "http://localhost:9000/thc-vms-bucket"

// fakeProfiles is a hand-written domain.ProfileRepository backed by the
// fakeUsers map: it records the call, applies the fully resolved update to the
// stored row, and returns the refreshed user like the PostgreSQL adapter.
type fakeProfiles struct {
	users      *fakeUsers
	calls      int
	lastID     domain.UUID
	lastUpdate domain.ProfileUpdate
	err        error
}

func (f *fakeProfiles) UpdateProfile(_ context.Context, id domain.UUID, update domain.ProfileUpdate) (domain.User, error) {
	f.calls++
	f.lastID = id
	f.lastUpdate = update
	if f.err != nil {
		return domain.User{}, f.err
	}
	user, ok := f.users.byID[id]
	if !ok {
		return domain.User{}, domain.ErrNotFound
	}
	user.Name = update.Name
	user.Phone = update.Phone
	user.AvatarURL = update.AvatarURL
	if update.PasswordHash != "" {
		user.PasswordHash = update.PasswordHash
	}
	f.users.byID[id] = user
	return user, nil
}

// fakeSelfStorage mirrors the MinIO adapter's own-bucket reversal rule for the
// profile photo namespace. It no longer mints read URLs: avatar reads stream
// through GET /avatars/{id}. Every DeleteObject call is recorded (keys in call
// order) so delete-on-replace tests can pin exactly what was reclaimed;
// deleteErr forces the best-effort failure path.
type fakeSelfStorage struct {
	deleted   []string
	deleteErr error
}

func (f *fakeSelfStorage) EnsureBucket(_ context.Context) error { return nil }

func (f *fakeSelfStorage) Upload(_ context.Context, _ domain.UploadRequest) (domain.UploadResult, error) {
	return domain.UploadResult{}, domain.ErrStorageRejected
}

func (f *fakeSelfStorage) PresignedURL(_ context.Context, _ string, _ time.Duration) (string, error) {
	return "", domain.ErrNotFound
}

func (f *fakeSelfStorage) DeleteObject(_ context.Context, key string) error {
	f.deleted = append(f.deleted, key)
	return f.deleteErr
}

func (f *fakeSelfStorage) ObjectKeyFromStoredURL(raw string) (string, error) {
	if !strings.HasPrefix(raw, selfStorageBase+"/") {
		return "", domain.ValidationFailure("Tautan berkas di luar bucket.")
	}
	key := strings.TrimPrefix(raw, selfStorageBase+"/")
	if i := strings.IndexAny(key, "?#"); i >= 0 {
		key = key[:i]
	}
	if key == "" || strings.Contains(key, "..") {
		return "", domain.ValidationFailure("Tautan berkas tidak valid.")
	}
	return key, nil
}

func roleIDFor(role domain.RoleName) domain.UUID {
	switch role {
	case domain.RoleSuperAdmin:
		return "role-superadmin"
	case domain.RoleDevSuperAdmin:
		return "role-devsuperadmin"
	case domain.RoleAdmin:
		return "role-admin"
	case domain.RoleSecurity:
		return "role-security"
	case domain.RoleVendor:
		return "role-vendor"
	default:
		return ""
	}
}

func seedSelfUser(t *testing.T, role domain.RoleName) (*fakeUsers, domain.User) {
	t.Helper()
	user := domain.User{
		ID:           "user-self-1",
		Name:         "Nama Lama",
		Email:        "self@thc.local",
		PasswordHash: hashPassword(t, "Password123!"),
		Phone:        "081200000000",
		RoleID:       roleIDFor(role),
		Type:         domain.UserTypeInternal,
		Status:       domain.UserStatusActive,
	}
	if role == domain.RoleVendor {
		user.Type = domain.UserTypeExternal
	}
	if role == domain.RoleAdmin || role == domain.RoleSecurity {
		loc := domain.UUID("loc-bandung")
		user.LocationID = &loc
	}
	users := &fakeUsers{
		byEmail: map[string]domain.User{user.Email: user},
		byID:    map[domain.UUID]domain.User{user.ID: user},
	}
	return users, user
}

func selfService(users *fakeUsers, profiles *fakeProfiles, storage domain.IStorageService) *Service {
	deps := loginDeps(users)
	deps.Profiles = profiles
	deps.Storage = storage
	return NewService(deps)
}

func selfAvatarURL(userID domain.UUID) string {
	return selfStorageBase + "/" + domain.ProfilePhotoOwnerPrefix(userID) + "avatar.jpg"
}

// avatarVersionOf derives the expected cache-busting version the way the
// contract defines it: the first 8 hex characters of sha256(stored).
func avatarVersionOf(stored string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(stored)))
	return hex.EncodeToString(sum[:])[:8]
}

func stringPtr(value string) *string { return &value }

// TestUpdateSelf_RoleFieldPolicyMatrix drives the real usecase for every
// role x field pair: allowed pairs write once, denied pairs return 403
// FORBIDDEN and never touch the repository.
func TestUpdateSelf_RoleFieldPolicyMatrix(t *testing.T) {
	allRoles := []domain.RoleName{domain.RoleSuperAdmin, domain.RoleAdmin, domain.RoleSecurity, domain.RoleVendor}
	fields := []struct {
		name    string
		input   func(domain.User) SelfUpdate
		allowed func(domain.RoleName) bool
	}{
		{
			name:  FieldName,
			input: func(domain.User) SelfUpdate { return SelfUpdate{Name: stringPtr("Nama Baru")} },
			allowed: func(role domain.RoleName) bool {
				return role == domain.RoleSuperAdmin
			},
		},
		{
			name:  FieldPhone,
			input: func(domain.User) SelfUpdate { return SelfUpdate{Phone: stringPtr("081234567891")} },
			allowed: func(domain.RoleName) bool {
				return true
			},
		},
		{
			name: FieldAvatarURL,
			input: func(user domain.User) SelfUpdate {
				return SelfUpdate{AvatarURL: stringPtr(selfAvatarURL(user.ID))}
			},
			allowed: func(domain.RoleName) bool {
				return true
			},
		},
	}

	for _, role := range allRoles {
		for _, field := range fields {
			t.Run(string(role)+"/"+field.name, func(t *testing.T) {
				users, user := seedSelfUser(t, role)
				profiles := &fakeProfiles{users: users}
				svc := selfService(users, profiles, &fakeSelfStorage{})

				_, err := svc.UpdateSelf(context.Background(),
					SelfIdentity{UserID: user.ID, Role: role}, field.input(user))

				if field.allowed(role) {
					if err != nil {
						t.Fatalf("UpdateSelf: %v", err)
					}
					if profiles.calls != 1 {
						t.Fatalf("UpdateProfile calls = %d, want 1", profiles.calls)
					}
					return
				}
				if err == nil {
					t.Fatalf("role %q editing %q succeeded, want FORBIDDEN", role, field.name)
				}
				appErr := appErrorOf(t, err)
				if appErr.Status != 403 || appErr.Code != "FORBIDDEN" {
					t.Fatalf("error = %d/%s, want 403/FORBIDDEN", appErr.Status, appErr.Code)
				}
				if !strings.Contains(appErr.Message, field.name) {
					t.Fatalf("message = %q, want it to name %q", appErr.Message, field.name)
				}
				if profiles.calls != 0 {
					t.Fatalf("UpdateProfile calls = %d, want 0 for a refused field", profiles.calls)
				}
			})
		}
	}
}

// TestUpdateSelf_VendorNameIsForbidden pins the security rule explicitly: a
// vendor sending name is refused and no write reaches the repository.
func TestUpdateSelf_VendorNameIsForbidden(t *testing.T) {
	users, user := seedSelfUser(t, domain.RoleVendor)
	profiles := &fakeProfiles{users: users}
	svc := selfService(users, profiles, &fakeSelfStorage{})

	_, err := svc.UpdateSelf(context.Background(),
		SelfIdentity{UserID: user.ID, Role: domain.RoleVendor},
		SelfUpdate{Name: stringPtr("Nama Curang")})

	if err == nil {
		t.Fatal("vendor name update succeeded, want FORBIDDEN")
	}
	appErr := appErrorOf(t, err)
	if appErr.Status != 403 || appErr.Code != "FORBIDDEN" {
		t.Fatalf("error = %d/%s, want 403/FORBIDDEN", appErr.Status, appErr.Code)
	}
	if profiles.calls != 0 {
		t.Fatalf("UpdateProfile calls = %d, want 0", profiles.calls)
	}
	if stored := users.byID[user.ID]; stored.Name != user.Name {
		t.Fatalf("stored name = %q, want unchanged %q", stored.Name, user.Name)
	}
}

// TestUpdateSelf_RejectsAvatarFromAnotherOwner proves the ownership proof: a
// key under a different pending-<userID> prefix is a validation failure and no
// write happens.
func TestUpdateSelf_RejectsAvatarFromAnotherOwner(t *testing.T) {
	users, user := seedSelfUser(t, domain.RoleVendor)
	profiles := &fakeProfiles{users: users}
	svc := selfService(users, profiles, &fakeSelfStorage{})
	foreign := selfAvatarURL(domain.UUID("user-other"))

	_, err := svc.UpdateSelf(context.Background(),
		SelfIdentity{UserID: user.ID, Role: domain.RoleVendor},
		SelfUpdate{AvatarURL: &foreign})

	if err == nil {
		t.Fatal("foreign avatar succeeded, want VALIDATION_ERROR")
	}
	appErr := appErrorOf(t, err)
	if appErr.Status != 400 || appErr.Code != "VALIDATION_ERROR" {
		t.Fatalf("error = %d/%s, want 400/VALIDATION_ERROR", appErr.Status, appErr.Code)
	}
	if profiles.calls != 0 {
		t.Fatalf("UpdateProfile calls = %d, want 0", profiles.calls)
	}
}

// TestUpdateSelf_RejectsInvalidAvatarURL covers foreign origins, malformed
// values, an empty string, and an over-long value with zero writes.
func TestUpdateSelf_RejectsInvalidAvatarURL(t *testing.T) {
	cases := []struct {
		name  string
		value string
	}{
		{"host asing", "https://evil.example/profile_photos/pending-user-self-1/avatar.jpg"},
		{"bukan url absolut", "profile_photos/pending-user-self-1/avatar.jpg"},
		{"string kosong", ""},
		{"terlalu panjang", selfStorageBase + "/" + domain.ProfilePhotoOwnerPrefix("user-self-1") + strings.Repeat("a", maxAvatarURLLength) + ".jpg"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			users, user := seedSelfUser(t, domain.RoleAdmin)
			profiles := &fakeProfiles{users: users}
			svc := selfService(users, profiles, &fakeSelfStorage{})
			value := tc.value

			_, err := svc.UpdateSelf(context.Background(),
				SelfIdentity{UserID: user.ID, Role: domain.RoleAdmin},
				SelfUpdate{AvatarURL: &value})

			if err == nil {
				t.Fatal("invalid avatar accepted, want VALIDATION_ERROR")
			}
			appErr := appErrorOf(t, err)
			if appErr.Status != 400 || appErr.Code != "VALIDATION_ERROR" {
				t.Fatalf("error = %d/%s, want 400/VALIDATION_ERROR", appErr.Status, appErr.Code)
			}
			if profiles.calls != 0 {
				t.Fatalf("UpdateProfile calls = %d, want 0", profiles.calls)
			}
		})
	}
}

// TestUpdateSelf_ClearAvatarResolvesToEmpty proves the explicit clear flag
// reaches the repository as "" (SQL NULL in the adapter), and that the object
// behind the blanked photo is reclaimed after the commit.
func TestUpdateSelf_ClearAvatarResolvesToEmpty(t *testing.T) {
	users, user := seedSelfUser(t, domain.RoleSecurity)
	user.AvatarURL = selfAvatarURL(user.ID)
	users.byID[user.ID] = user
	profiles := &fakeProfiles{users: users}
	storage := &fakeSelfStorage{}
	svc := selfService(users, profiles, storage)

	got, err := svc.UpdateSelf(context.Background(),
		SelfIdentity{UserID: user.ID, Role: domain.RoleSecurity},
		SelfUpdate{ClearAvatar: true})
	if err != nil {
		t.Fatalf("UpdateSelf clear avatar: %v", err)
	}
	if profiles.calls != 1 {
		t.Fatalf("UpdateProfile calls = %d, want 1", profiles.calls)
	}
	if profiles.lastUpdate.AvatarURL != "" {
		t.Fatalf("stored avatar = %q, want empty (SQL NULL)", profiles.lastUpdate.AvatarURL)
	}
	if got.AvatarURL != "" {
		t.Fatalf("response avatar = %q, want empty", got.AvatarURL)
	}
	wantKey := domain.ProfilePhotoOwnerPrefix(user.ID) + "avatar.jpg"
	if len(storage.deleted) != 1 || storage.deleted[0] != wantKey {
		t.Fatalf("deleted = %v, want [%q]", storage.deleted, wantKey)
	}
}

// TestUpdateSelf_RejectsEmptyInput proves a body with no editable member is a
// 400, never a silent success.
func TestUpdateSelf_RejectsEmptyInput(t *testing.T) {
	users, user := seedSelfUser(t, domain.RoleAdmin)
	profiles := &fakeProfiles{users: users}
	svc := selfService(users, profiles, &fakeSelfStorage{})

	_, err := svc.UpdateSelf(context.Background(),
		SelfIdentity{UserID: user.ID, Role: domain.RoleAdmin}, SelfUpdate{})

	if err == nil {
		t.Fatal("empty update succeeded, want VALIDATION_ERROR")
	}
	appErr := appErrorOf(t, err)
	if appErr.Status != 400 || appErr.Code != "VALIDATION_ERROR" {
		t.Fatalf("error = %d/%s, want 400/VALIDATION_ERROR", appErr.Status, appErr.Code)
	}
	if profiles.calls != 0 {
		t.Fatalf("UpdateProfile calls = %d, want 0", profiles.calls)
	}
}

// TestUpdateSelf_PhoneValidationAndNormalisation pins the shared phone rule:
// invalid numbers are rejected, valid ones are stored in canonical form.
func TestUpdateSelf_PhoneValidationAndNormalisation(t *testing.T) {
	cases := []struct {
		name       string
		value      string
		wantStored string
		wantError  bool
	}{
		{"tidak valid", "123", "", true},
		{"kosong", "   ", "", true},
		{"awalan internasional", "+62 812-3456-7890", "081234567890", false},
		{"awalan lokal berspasi", "0812 3456 7890", "081234567890", false},
		{"9 digit", "081234567", "", true},
		{"10 digit", "0812345678", "0812345678", false},
		{"16 digit", "0812345678901234", "0812345678901234", false},
		{"17 digit", "08123456789012345", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			users, user := seedSelfUser(t, domain.RoleVendor)
			profiles := &fakeProfiles{users: users}
			svc := selfService(users, profiles, &fakeSelfStorage{})

			_, err := svc.UpdateSelf(context.Background(),
				SelfIdentity{UserID: user.ID, Role: domain.RoleVendor},
				SelfUpdate{Phone: stringPtr(tc.value)})

			if tc.wantError {
				if err == nil {
					t.Fatal("invalid phone accepted, want VALIDATION_ERROR")
				}
				if got := appErrorOf(t, err); got.Status != 400 || got.Code != "VALIDATION_ERROR" {
					t.Fatalf("error = %d/%s, want 400/VALIDATION_ERROR", got.Status, got.Code)
				}
				if profiles.calls != 0 {
					t.Fatalf("UpdateProfile calls = %d, want 0", profiles.calls)
				}
				return
			}
			if err != nil {
				t.Fatalf("UpdateSelf: %v", err)
			}
			if profiles.lastUpdate.Phone != tc.wantStored {
				t.Fatalf("stored phone = %q, want %q", profiles.lastUpdate.Phone, tc.wantStored)
			}
		})
	}
}

// TestUpdateSelf_AuditRecordsNameChange pins the user.update trail: source
// self, the changed field list, and the old/new name pair audit_log needs.
func TestUpdateSelf_AuditRecordsNameChange(t *testing.T) {
	users, user := seedSelfUser(t, domain.RoleSuperAdmin)
	profiles := &fakeProfiles{users: users}
	audit := &fakeAudit{}
	deps := loginDeps(users)
	deps.Profiles = profiles
	deps.Audit = audit
	svc := NewService(deps)

	newName := "Nama Baru"
	if _, err := svc.UpdateSelf(auditCtx(),
		SelfIdentity{UserID: user.ID, Role: domain.RoleSuperAdmin},
		SelfUpdate{Name: &newName}); err != nil {
		t.Fatalf("UpdateSelf: %v", err)
	}
	if len(audit.entries) != 1 {
		t.Fatalf("audit entries = %d, want exactly 1", len(audit.entries))
	}
	entry := audit.entries[0]
	if entry.Action != domain.AuditActionUserUpdate {
		t.Fatalf("action = %q, want %q", entry.Action, domain.AuditActionUserUpdate)
	}
	if entry.Entity != domain.AuditEntityUser {
		t.Fatalf("entity = %q, want %q", entry.Entity, domain.AuditEntityUser)
	}
	if entry.ActorID == nil || *entry.ActorID != user.ID {
		t.Fatalf("actor = %v, want %q", entry.ActorID, user.ID)
	}
	if entry.EntityID == nil || *entry.EntityID != user.ID {
		t.Fatalf("entity id = %v, want %q", entry.EntityID, user.ID)
	}
	if entry.IP != "203.0.113.7" || entry.UserAgent != "AuditTest/1.0" {
		t.Fatalf("provenance = %+v, want the request meta", entry)
	}
	if entry.Metadata["source"] != "self" {
		t.Fatalf("metadata source = %q, want self", entry.Metadata["source"])
	}
	if entry.Metadata["fields"] != FieldName {
		t.Fatalf("metadata fields = %q, want %q", entry.Metadata["fields"], FieldName)
	}
	if entry.Metadata["old_name"] != user.Name {
		t.Fatalf("old_name = %q, want %q", entry.Metadata["old_name"], user.Name)
	}
	if entry.Metadata["new_name"] != newName {
		t.Fatalf("new_name = %q, want %q", entry.Metadata["new_name"], newName)
	}
}

// TestUpdateSelf_AuditFailureNeverFailsRequest proves a trail outage cannot
// turn a successful profile write into an error.
func TestUpdateSelf_AuditFailureNeverFailsRequest(t *testing.T) {
	users, user := seedSelfUser(t, domain.RoleAdmin)
	profiles := &fakeProfiles{users: users}
	audit := &fakeAudit{appendErr: errors.New("trail unavailable")}
	deps := loginDeps(users)
	deps.Profiles = profiles
	deps.Audit = audit
	svc := NewService(deps)

	if _, err := svc.UpdateSelf(auditCtx(),
		SelfIdentity{UserID: user.ID, Role: domain.RoleAdmin},
		SelfUpdate{Phone: stringPtr("081234567891")}); err != nil {
		t.Fatalf("profile write must succeed despite audit failure: %v", err)
	}
	if profiles.calls != 1 {
		t.Fatalf("UpdateProfile calls = %d, want 1", profiles.calls)
	}
}

// TestMe_ReportsAvatarAPIPathAndEditableFields pins the read path: the stored
// absolute URL becomes the host-agnostic API path and the policy list travels
// with the profile.
func TestMe_ReportsAvatarAPIPathAndEditableFields(t *testing.T) {
	users, user := seedSelfUser(t, domain.RoleAdmin)
	user.AvatarURL = selfAvatarURL(user.ID)
	users.byID[user.ID] = user
	svc := NewService(loginDeps(users))

	got, err := svc.Me(context.Background(), user.ID)
	if err != nil {
		t.Fatalf("Me: %v", err)
	}
	want := "/api/v1/avatars/" + string(user.ID) + "?v=" + avatarVersionOf(selfAvatarURL(user.ID))
	if got.AvatarURL != want {
		t.Fatalf("avatar_url = %q, want the API path %q", got.AvatarURL, want)
	}
	if strings.Contains(got.AvatarURL, selfStorageBase) {
		t.Fatalf("avatar_url = %q, the raw bucket address must never reach the client", got.AvatarURL)
	}
	wantFields := []string{FieldPhone, FieldAvatarURL}
	if len(got.EditableFields) != len(wantFields) {
		t.Fatalf("editable_fields = %v, want %v", got.EditableFields, wantFields)
	}
	for i := range wantFields {
		if got.EditableFields[i] != wantFields[i] {
			t.Fatalf("editable_fields = %v, want %v", got.EditableFields, wantFields)
		}
	}
}

// TestUpdateSelf_BlankAvatarStaysEmpty pins the no-photo contract: an account without
// a stored avatar answers an empty avatar_url, never a path.
func TestMe_BlankAvatarStaysEmpty(t *testing.T) {
	users, user := seedSelfUser(t, domain.RoleVendor)
	svc := NewService(loginDeps(users))

	got, err := svc.Me(context.Background(), user.ID)
	if err != nil {
		t.Fatalf("Me: %v", err)
	}
	if got.AvatarURL != "" {
		t.Fatalf("avatar_url = %q, want empty without a stored avatar", got.AvatarURL)
	}
}

// TestUpdateSelf_ReplacedAvatarDeletesOldObject pins delete-on-replace: a
// successful swap reclaims the object behind the previous photo and never
// touches the object the new URL points at.
func TestUpdateSelf_ReplacedAvatarDeletesOldObject(t *testing.T) {
	users, user := seedSelfUser(t, domain.RoleVendor)
	user.AvatarURL = selfAvatarURL(user.ID)
	users.byID[user.ID] = user
	profiles := &fakeProfiles{users: users}
	storage := &fakeSelfStorage{}
	svc := selfService(users, profiles, storage)
	newAvatar := selfStorageBase + "/" + domain.ProfilePhotoOwnerPrefix(user.ID) + "avatar-baru.jpg"

	got, err := svc.UpdateSelf(context.Background(),
		SelfIdentity{UserID: user.ID, Role: domain.RoleVendor},
		SelfUpdate{AvatarURL: &newAvatar})
	if err != nil {
		t.Fatalf("UpdateSelf replace avatar: %v", err)
	}
	if profiles.calls != 1 {
		t.Fatalf("UpdateProfile calls = %d, want 1", profiles.calls)
	}
	oldKey := domain.ProfilePhotoOwnerPrefix(user.ID) + "avatar.jpg"
	newKey := domain.ProfilePhotoOwnerPrefix(user.ID) + "avatar-baru.jpg"
	if len(storage.deleted) != 1 || storage.deleted[0] != oldKey {
		t.Fatalf("deleted = %v, want [%q]", storage.deleted, oldKey)
	}
	for _, key := range storage.deleted {
		if key == newKey {
			t.Fatalf("new object %q must never be deleted", newKey)
		}
	}
	if profiles.lastUpdate.AvatarURL != newAvatar {
		t.Fatalf("stored avatar = %q, want %q", profiles.lastUpdate.AvatarURL, newAvatar)
	}
	if got.AvatarURL == "" {
		t.Fatal("response avatar is empty, want the refreshed projection")
	}
}

// TestUpdateSelf_SameKeyAvatarSkipsDelete pins the same-key guard: raw URLs
// that differ only by the cache-busting version reverse to one object key, and
// because PutObject already overwrote that key in place the delete must be
// skipped entirely.
func TestUpdateSelf_SameKeyAvatarSkipsDelete(t *testing.T) {
	users, user := seedSelfUser(t, domain.RoleAdmin)
	stored := selfAvatarURL(user.ID)
	user.AvatarURL = stored
	users.byID[user.ID] = user
	profiles := &fakeProfiles{users: users}
	storage := &fakeSelfStorage{}
	svc := selfService(users, profiles, storage)
	versioned := stored + "?v=" + avatarVersionOf(stored)

	if _, err := svc.UpdateSelf(context.Background(),
		SelfIdentity{UserID: user.ID, Role: domain.RoleAdmin},
		SelfUpdate{AvatarURL: &versioned}); err != nil {
		t.Fatalf("UpdateSelf same-key avatar: %v", err)
	}
	if profiles.calls != 1 {
		t.Fatalf("UpdateProfile calls = %d, want 1", profiles.calls)
	}
	if len(storage.deleted) != 0 {
		t.Fatalf("deleted = %v, want zero deletes for a same-key replace", storage.deleted)
	}
}

// TestUpdateSelf_AvatarDeleteFailureNeverFailsRequest proves the delete is
// best-effort: a storage outage after the commit is logged and the caller
// still gets a successful (HTTP 200) response with the new avatar stored.
func TestUpdateSelf_AvatarDeleteFailureNeverFailsRequest(t *testing.T) {
	users, user := seedSelfUser(t, domain.RoleAdmin)
	user.AvatarURL = selfAvatarURL(user.ID)
	users.byID[user.ID] = user
	profiles := &fakeProfiles{users: users}
	storage := &fakeSelfStorage{deleteErr: errors.New("minio unreachable")}
	svc := selfService(users, profiles, storage)
	newAvatar := selfStorageBase + "/" + domain.ProfilePhotoOwnerPrefix(user.ID) + "avatar-baru.jpg"

	got, err := svc.UpdateSelf(context.Background(),
		SelfIdentity{UserID: user.ID, Role: domain.RoleAdmin},
		SelfUpdate{AvatarURL: &newAvatar})
	if err != nil {
		t.Fatalf("delete failure must not fail the request (HTTP 200): %v", err)
	}
	if profiles.calls != 1 {
		t.Fatalf("UpdateProfile calls = %d, want 1", profiles.calls)
	}
	oldKey := domain.ProfilePhotoOwnerPrefix(user.ID) + "avatar.jpg"
	if len(storage.deleted) != 1 || storage.deleted[0] != oldKey {
		t.Fatalf("deleted = %v, want the attempt on [%q]", storage.deleted, oldKey)
	}
	if profiles.lastUpdate.AvatarURL != newAvatar {
		t.Fatalf("stored avatar = %q, want %q despite the delete failure", profiles.lastUpdate.AvatarURL, newAvatar)
	}
	if got.AvatarURL == "" {
		t.Fatal("response avatar is empty, want the refreshed projection")
	}
}
