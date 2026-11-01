package auth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"

	"thc-vms/backend/internal/config"
	"thc-vms/backend/internal/domain"
	thcjwt "thc-vms/backend/internal/infrastructure/jwt"
)

// fakeUsers is a hand-written fake of domain.UserRepository: no database, no
// mocking library. Emails are keyed exact-match so the test proves the
// usecase lower-cases before lookup.
type fakeUsers struct {
	byEmail      map[string]domain.User
	byID         map[domain.UUID]domain.User
	lastLoginAt  map[domain.UUID]time.Time
	lastLoginErr error
	findEmailErr error
	findIDErr    error
	updateCalls  int
}

func (f *fakeUsers) FindByEmail(_ context.Context, email string) (domain.User, error) {
	if f.findEmailErr != nil {
		return domain.User{}, f.findEmailErr
	}
	user, ok := f.byEmail[email]
	if !ok {
		return domain.User{}, domain.ErrNotFound
	}
	return user, nil
}

func (f *fakeUsers) FindByID(_ context.Context, id domain.UUID) (domain.User, error) {
	if f.findIDErr != nil {
		return domain.User{}, f.findIDErr
	}
	user, ok := f.byID[id]
	if !ok {
		return domain.User{}, domain.ErrNotFound
	}
	return user, nil
}

func (f *fakeUsers) Create(_ context.Context, user domain.User) (domain.User, error) {
	return user, nil
}

func (f *fakeUsers) UpdateStatus(_ context.Context, _ domain.UUID, _ domain.UserStatus) error {
	return nil
}

func (f *fakeUsers) UpdateLastLogin(_ context.Context, id domain.UUID, at time.Time) error {
	f.updateCalls++
	if f.lastLoginErr != nil {
		return f.lastLoginErr
	}
	if f.lastLoginAt == nil {
		f.lastLoginAt = map[domain.UUID]time.Time{}
	}
	f.lastLoginAt[id] = at
	return nil
}

func (f *fakeUsers) ListSecurity(_ context.Context, _ *domain.UUID) ([]domain.User, error) {
	return nil, nil
}

// fakeClock is a hand-written frozen Clock.
type fakeClock struct{ now time.Time }

func (f fakeClock) Now() time.Time { return f.now }

// fakeIssuer captures the user handed to Issue and returns a canned token.
type fakeIssuer struct {
	seen  domain.User
	token string
	err   error
}

func (f *fakeIssuer) Issue(user domain.User) (string, error) {
	f.seen = user
	if f.err != nil {
		return "", f.err
	}
	if f.token != "" {
		return f.token, nil
	}
	return "test-token", nil
}

// fakeRoles resolves role ids to names without a database.
type fakeRoles struct {
	names map[domain.UUID]domain.RoleName
}

func (f fakeRoles) LookupRole(_ context.Context, id domain.UUID) (domain.RoleName, error) {
	name, ok := f.names[id]
	if !ok {
		return "", domain.ErrNotFound
	}
	return name, nil
}

// fakeLocations resolves one branch without a database.
type fakeLocations struct {
	locations map[domain.UUID]domain.Location
	err       error
}

func (f fakeLocations) ListLocations(_ context.Context, _ bool) ([]domain.Location, error) {
	return nil, nil
}

func (f fakeLocations) FindLocationByID(_ context.Context, id domain.UUID) (domain.Location, error) {
	if f.err != nil {
		return domain.Location{}, f.err
	}
	loc, ok := f.locations[id]
	if !ok {
		return domain.Location{}, domain.ErrNotFound
	}
	return loc, nil
}

func (f fakeLocations) ListPurposes(_ context.Context, _ bool) ([]domain.Purpose, error) {
	return nil, nil
}

func hashPassword(t *testing.T, password string) string {
	t.Helper()
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("hash password: %v", err)
	}
	return string(hash)
}

func loginDeps(users *fakeUsers) Deps {
	loc := domain.UUID("loc-bandung")
	return Deps{
		Users: users,
		Roles: fakeRoles{names: map[domain.UUID]domain.RoleName{
			"role-superadmin":    domain.RoleSuperAdmin,
			"role-devsuperadmin": domain.RoleDevSuperAdmin,
			"role-admin":         domain.RoleAdmin,
			"role-security":      domain.RoleSecurity,
			"role-vendor":        domain.RoleVendor,
		}},
		Locations: fakeLocations{locations: map[domain.UUID]domain.Location{
			"loc-bandung": {ID: loc, Name: "THC Cabang Bandung"},
		}},
		Issuer: &fakeIssuer{},
		Clock:  fakeClock{now: time.Now()},
	}
}

func activeAdmin(password string) domain.User {
	loc := domain.UUID("loc-bandung")
	return domain.User{
		ID:           "user-admin-1",
		Name:         "Admin Bandung",
		Email:        "admin@thc.local",
		PasswordHash: password,
		Phone:        "0811",
		RoleID:       "role-admin",
		LocationID:   &loc,
		Type:         domain.UserTypeInternal,
		Status:       domain.UserStatusActive,
	}
}

// decodeLoginPayload decodes the RAW middle segment of got.Token without
// verifying, so the test asserts on the exact wire JSON.
func decodeLoginPayload(t *testing.T, token string) (map[string]any, string) {
	t.Helper()
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("expected 3 token segments, got %d", len(parts))
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	return payload, string(raw)
}

func appErrorOf(t *testing.T, err error) *domain.AppError {
	t.Helper()
	var appErr *domain.AppError
	if !errors.As(err, &appErr) {
		t.Fatalf("error type = %T, want *domain.AppError", err)
	}
	return appErr
}

// realIssuer wires the production JWT service with a map directory so the
// claims tests prove the exact wire payload end to end.
func realIssuer() *thcjwt.Service {
	dir := jwtMapDirectory{
		roles: map[domain.UUID]domain.RoleName{
			"role-superadmin": domain.RoleSuperAdmin,
			"role-admin":      domain.RoleAdmin,
			"role-security":   domain.RoleSecurity,
			"role-vendor":     domain.RoleVendor,
		},
		locations: map[domain.UUID]string{"loc-bandung": "THC Cabang Bandung"},
	}
	cfg := &config.Config{JWT: config.JWT{Secret: "auth-claims-test-secret-32-chars-min", ExpirationHours: 24}}
	return thcjwt.NewService(cfg).WithDirectory(dir)
}

// jwtMapDirectory adapts the test maps to the jwt.Directory interface.
type jwtMapDirectory struct {
	roles     map[domain.UUID]domain.RoleName
	locations map[domain.UUID]string
}

func (m jwtMapDirectory) LookupRole(id domain.UUID) (domain.RoleName, error) {
	role, ok := m.roles[id]
	if !ok {
		return "", domain.ErrNotFound
	}
	return role, nil
}

func (m jwtMapDirectory) LookupLocation(id domain.UUID) (string, error) {
	name, ok := m.locations[id]
	if !ok {
		return "", domain.ErrNotFound
	}
	return name, nil
}

func TestLogin_IssuesTokenWithExactlyTheFourMandatedClaims(t *testing.T) {
	users := &fakeUsers{byEmail: map[string]domain.User{}, byID: map[domain.UUID]domain.User{}}
	admin := activeAdmin(hashPassword(t, "Password123!"))
	users.byEmail["admin@thc.local"] = admin
	users.byID[admin.ID] = admin
	deps := loginDeps(users)
	deps.Issuer = realIssuer()
	svc := NewService(deps)

	before := time.Now()
	got, err := svc.Login(context.Background(), "admin@thc.local", "Password123!")
	if err != nil {
		t.Fatalf("Login: %v", err)
	}

	payload, _ := decodeLoginPayload(t, got.Token)
	for _, key := range []string{"sub", "role", "location_id", "location_name", "exp", "iat"} {
		if _, ok := payload[key]; !ok {
			t.Fatalf("claim %q missing from payload %v", key, payload)
		}
	}
	if payload["sub"] != "user-admin-1" {
		t.Fatalf("sub = %v, want user-admin-1", payload["sub"])
	}
	if payload["role"] != "admin" {
		t.Fatalf("role = %v, want admin", payload["role"])
	}
	if payload["location_id"] != "loc-bandung" {
		t.Fatalf("location_id = %v, want loc-bandung", payload["location_id"])
	}
	for _, forbidden := range []string{"password_hash", "email", "vendor_id", "password"} {
		if _, ok := payload[forbidden]; ok {
			t.Fatalf("claim %q must never be in the token", forbidden)
		}
	}
	exp, ok := payload["exp"].(float64)
	if !ok {
		t.Fatalf("exp is not numeric: %v", payload["exp"])
	}
	wantExp := before.Add(24 * time.Hour).Unix()
	if diff := exp - float64(wantExp); diff < -300 || diff > 300 {
		t.Fatalf("exp = %v, want ~24h out (diff %vs)", exp, diff)
	}
	if got.User.ID != admin.ID {
		t.Fatalf("profile id = %q, want %q", got.User.ID, admin.ID)
	}
}

func TestLogin_LocationIDIsJSONNullForSuperAdminAndVendor(t *testing.T) {
	makeSvc := func(user domain.User) *Service {
		users := &fakeUsers{
			byEmail: map[string]domain.User{user.Email: user},
			byID:    map[domain.UUID]domain.User{user.ID: user},
		}
		deps := loginDeps(users)
		deps.Issuer = realIssuer()
		return NewService(deps)
	}

	superAdmin := domain.User{
		ID:           "user-super-1",
		Email:        "superadmin@thc.local",
		PasswordHash: hashPassword(t, "Password123!"),
		RoleID:       "role-superadmin",
		LocationID:   nil,
		Type:         domain.UserTypeInternal,
		Status:       domain.UserStatusActive,
	}
	svc := makeSvc(superAdmin)
	got, err := svc.Login(context.Background(), "superadmin@thc.local", "Password123!")
	if err != nil {
		t.Fatalf("super_admin Login: %v", err)
	}
	payload, raw := decodeLoginPayload(t, got.Token)
	value, present := payload["location_id"]
	if !present {
		t.Fatal("super_admin: location_id key missing, want explicit null")
	}
	if value != nil {
		t.Fatalf("super_admin: location_id = %v, want JSON null", value)
	}
	if !strings.Contains(raw, `"location_id":null`) {
		t.Fatalf("super_admin: raw payload lacks literal null: %s", raw)
	}

	vendor := domain.User{
		ID:           "user-vendor-1",
		Email:        "vendor@vendor.example",
		PasswordHash: hashPassword(t, "Password123!"),
		RoleID:       "role-vendor",
		LocationID:   nil,
		Type:         domain.UserTypeExternal,
		Status:       domain.UserStatusActive,
	}
	svc = makeSvc(vendor)
	got, err = svc.Login(context.Background(), "vendor@vendor.example", "Password123!")
	if err != nil {
		t.Fatalf("vendor Login: %v", err)
	}
	payload, raw = decodeLoginPayload(t, got.Token)
	value, present = payload["location_id"]
	if !present || value != nil {
		t.Fatalf("vendor: location_id = %v (present=%v), want JSON null", value, present)
	}
	if !strings.Contains(raw, `"location_id":null`) {
		t.Fatalf("vendor: raw payload lacks literal null: %s", raw)
	}

	admin := activeAdmin(hashPassword(t, "Password123!"))
	svc = makeSvc(admin)
	got, err = svc.Login(context.Background(), "admin@thc.local", "Password123!")
	if err != nil {
		t.Fatalf("admin Login: %v", err)
	}
	payload, _ = decodeLoginPayload(t, got.Token)
	if payload["location_id"] != "loc-bandung" {
		t.Fatalf("admin: location_id = %v, want loc-bandung UUID string", payload["location_id"])
	}
}

func TestLogin_WrongPasswordReturnsIdenticalErrorToUnknownEmail(t *testing.T) {
	users := &fakeUsers{byEmail: map[string]domain.User{}, byID: map[domain.UUID]domain.User{}}
	admin := activeAdmin(hashPassword(t, "Password123!"))
	users.byEmail["admin@thc.local"] = admin
	users.byID[admin.ID] = admin
	svc := NewService(loginDeps(users))

	_, wrongErr := svc.Login(context.Background(), "admin@thc.local", "WrongPassword!")
	_, unknownErr := svc.Login(context.Background(), "ghost@thc.local", "WrongPassword!")

	if wrongErr == nil || unknownErr == nil {
		t.Fatalf("wrong=%v unknown=%v, want both to fail", wrongErr, unknownErr)
	}
	wrong := appErrorOf(t, wrongErr)
	unknown := appErrorOf(t, unknownErr)
	if wrong.Code != unknown.Code || wrong.Message != unknown.Message {
		t.Fatalf("mismatch: wrong=(%s,%s) unknown=(%s,%s), want identical",
			wrong.Code, wrong.Message, unknown.Code, unknown.Message)
	}
	if wrong.Code != "INVALID_CREDENTIALS" || wrong.Message != "Kredensial tidak valid" {
		t.Fatalf("got (%s,%s), want (INVALID_CREDENTIALS,Kredensial tidak valid)", wrong.Code, wrong.Message)
	}
}

func TestLogin_RejectsInactiveAndBlacklistedAccounts(t *testing.T) {
	users := &fakeUsers{byEmail: map[string]domain.User{}, byID: map[domain.UUID]domain.User{}}
	inactive := activeAdmin(hashPassword(t, "Password123!"))
	inactive.ID = "user-inactive-1"
	inactive.Email = "inactive@thc.local"
	inactive.Status = domain.UserStatusInactive
	blacklisted := activeAdmin(hashPassword(t, "Password123!"))
	blacklisted.ID = "user-black-1"
	blacklisted.Email = "black@thc.local"
	blacklisted.Status = domain.UserStatusBlacklisted
	users.byEmail[inactive.Email] = inactive
	users.byEmail[blacklisted.Email] = blacklisted
	pending := activeAdmin(hashPassword(t, "Password123!"))
	pending.ID = "user-pending-1"
	pending.Email = "pending@vendor.example"
	pending.Status = domain.UserStatusPending
	users.byEmail[pending.Email] = pending
	svc := NewService(loginDeps(users))

	_, err := svc.Login(context.Background(), "inactive@thc.local", "Password123!")
	if err == nil {
		t.Fatal("inactive login succeeded, want 403")
	}
	if got := appErrorOf(t, err); got.Status != 403 || got.Code != "ACCOUNT_PENDING" || got.Message != "Akun Anda menunggu persetujuan superadmin." {
		t.Fatalf("inactive: got (%d,%s,%s), want the pending-approval 403", got.Status, got.Code, got.Message)
	}

	_, err = svc.Login(context.Background(), "pending@vendor.example", "Password123!")
	if err == nil {
		t.Fatal("pending login succeeded, want 403")
	}
	if got := appErrorOf(t, err); got.Status != 403 || got.Code != "ACCOUNT_PENDING" || got.Message != "Akun Anda menunggu persetujuan superadmin." {
		t.Fatalf("pending: got (%d,%s,%s), want the pending-approval 403", got.Status, got.Code, got.Message)
	}

	_, err = svc.Login(context.Background(), "black@thc.local", "Password123!")
	if err == nil {
		t.Fatal("blacklisted login succeeded, want 401")
	}
	if got := appErrorOf(t, err); got.Code != "INVALID_CREDENTIALS" || got.Message != "Kredensial tidak valid" {
		t.Fatalf("blacklisted: got (%s,%s), want the identical 401", got.Code, got.Message)
	}
}

func TestLogin_UpdateLastLoginFailureStillSucceeds(t *testing.T) {
	users := &fakeUsers{byEmail: map[string]domain.User{}, byID: map[domain.UUID]domain.User{}}
	admin := activeAdmin(hashPassword(t, "Password123!"))
	users.byEmail["admin@thc.local"] = admin
	users.byID[admin.ID] = admin
	users.lastLoginErr = errors.New("connection refused")
	svc := NewService(loginDeps(users))

	got, err := svc.Login(context.Background(), "admin@thc.local", "Password123!")
	if err != nil {
		t.Fatalf("Login with failing UpdateLastLogin: %v", err)
	}
	if got.Token == "" {
		t.Fatal("empty token despite successful login")
	}
	if users.updateCalls != 1 {
		t.Fatalf("UpdateLastLogin calls = %d, want 1 attempt", users.updateCalls)
	}
}

func TestLogin_EmailLookupIsCaseInsensitive(t *testing.T) {
	users := &fakeUsers{byEmail: map[string]domain.User{}, byID: map[domain.UUID]domain.User{}}
	admin := activeAdmin(hashPassword(t, "Password123!"))
	users.byEmail["admin@thc.local"] = admin
	users.byID[admin.ID] = admin
	svc := NewService(loginDeps(users))

	got, err := svc.Login(context.Background(), "  ADMIN@THC.Local  ", "Password123!")
	if err != nil {
		t.Fatalf("Login with mixed-case padded email: %v", err)
	}
	if got.Token == "" {
		t.Fatal("empty token for case-insensitive login")
	}
	if got.User.Email != "admin@thc.local" {
		t.Fatalf("profile email = %q, want stored form", got.User.Email)
	}
}

// TestLogin_AvatarURLIsAPIPath pins the login read path: the account row feeds
// the same profile projection as GET /auth/me, so a stored absolute avatar URL
// must come back as the host-agnostic API path. The repository regression test
// covers the SQL projection; this one covers the projection step the login
// response runs through.
func TestLogin_AvatarURLIsAPIPath(t *testing.T) {
	users := &fakeUsers{byEmail: map[string]domain.User{}, byID: map[domain.UUID]domain.User{}}
	admin := activeAdmin(hashPassword(t, "Password123!"))
	admin.AvatarURL = selfAvatarURL(admin.ID)
	users.byEmail["admin@thc.local"] = admin
	users.byID[admin.ID] = admin
	svc := NewService(loginDeps(users))

	got, err := svc.Login(context.Background(), "admin@thc.local", "Password123!")
	if err != nil {
		t.Fatalf("Login: %v", err)
	}

	want := "/api/v1/avatars/" + string(admin.ID) + "?v=" + avatarVersionOf(selfAvatarURL(admin.ID))
	if got.User.AvatarURL != want {
		t.Fatalf("avatar_url = %q, want the API path %q", got.User.AvatarURL, want)
	}
	if strings.Contains(got.User.AvatarURL, selfStorageBase) {
		t.Fatalf("avatar_url = %q, the raw bucket address must never reach the client", got.User.AvatarURL)
	}
}

// TestLogin_BlankAvatarStaysEmpty pins the no-photo contract: an account
// without a stored avatar answers an empty avatar_url, never a path.
func TestLogin_BlankAvatarStaysEmpty(t *testing.T) {
	users := &fakeUsers{byEmail: map[string]domain.User{}, byID: map[domain.UUID]domain.User{}}
	admin := activeAdmin(hashPassword(t, "Password123!"))
	users.byEmail["admin@thc.local"] = admin
	users.byID[admin.ID] = admin
	svc := NewService(loginDeps(users))

	got, err := svc.Login(context.Background(), "admin@thc.local", "Password123!")
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	if got.Token == "" {
		t.Fatal("empty token")
	}
	if got.User.AvatarURL != "" {
		t.Fatalf("avatar_url = %q, want empty without a stored avatar", got.User.AvatarURL)
	}
}
