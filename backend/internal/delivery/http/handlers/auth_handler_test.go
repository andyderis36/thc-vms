package handlers_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/config"
	"thc-vms/backend/internal/delivery/http/handlers"
	"thc-vms/backend/internal/delivery/http/middleware"
	"thc-vms/backend/internal/domain"
	infraJWT "thc-vms/backend/internal/infrastructure/jwt"
	"thc-vms/backend/internal/usecase/auth"
)

// stubAuthService is a hand-written fake for handlers.AuthService: no
// mocking library, no testify.
type stubAuthService struct {
	profile        auth.Profile
	token          string
	loginErr       error
	meErr          error
	lastLoginEmail string
	lastMeID       domain.UUID
	logoutCalls    int

	updateSelfErr   error
	updateSelfCalls int
	lastSelfActor   auth.SelfIdentity
	lastSelfUpdate  auth.SelfUpdate

	registerErr       error
	lastRegisterInput *auth.RegisterVendorInput
}

func (s *stubAuthService) Login(_ context.Context, email, password string) (auth.LoginResult, error) {
	s.lastLoginEmail = email + "\x00" + password
	if s.loginErr != nil {
		return auth.LoginResult{}, s.loginErr
	}
	return auth.LoginResult{Token: s.token, User: s.profile}, nil
}

func (s *stubAuthService) Me(_ context.Context, id domain.UUID) (auth.Profile, error) {
	s.lastMeID = id
	if s.meErr != nil {
		return auth.Profile{}, s.meErr
	}
	return s.profile, nil
}

func (s *stubAuthService) UpdateSelf(_ context.Context, actor auth.SelfIdentity, in auth.SelfUpdate) (auth.Profile, error) {
	s.updateSelfCalls++
	s.lastSelfActor = actor
	s.lastSelfUpdate = in
	if s.updateSelfErr != nil {
		return auth.Profile{}, s.updateSelfErr
	}
	return s.profile, nil
}

func (s *stubAuthService) Logout(_ context.Context) error {
	s.logoutCalls++
	return nil
}

func (s *stubAuthService) RegisterVendor(_ context.Context, in auth.RegisterVendorInput) (auth.Profile, error) {
	s.lastRegisterInput = &in
	if s.registerErr != nil {
		return auth.Profile{}, s.registerErr
	}
	return s.profile, nil
}

func cannedAuthProfile() auth.Profile {
	loc := domain.UUID("loc-1")
	name := "Kantor Cabang Surabaya"
	return auth.Profile{
		ID:           "user-1",
		Name:         "Admin Surabaya",
		Email:        "admin@thc.local",
		Phone:        "081234567890",
		Role:         domain.RoleAdmin,
		LocationID:   &loc,
		LocationName: &name,
		Status:       domain.UserStatusActive,
		Type:         domain.UserTypeInternal,
	}
}

func newAuthEngine(svc *stubAuthService, role domain.RoleName, loc string) *gin.Engine {
	engine := gin.New()
	engine.Use(withActor(role, loc))
	h := handlers.NewAuthHandler(svc)
	engine.POST("/auth/login", h.Login)
	engine.GET("/auth/me", h.Me)
	engine.PATCH("/auth/me", h.PatchMe)
	engine.POST("/auth/logout", h.Logout)
	return engine
}

func testParser(secret string) *infraJWT.Service {
	return infraJWT.NewService(&config.Config{JWT: config.JWT{Secret: secret, ExpirationHours: 1}})
}

func TestLogin_Returns200WithTokenAndUser(t *testing.T) {
	svc := &stubAuthService{profile: cannedAuthProfile(), token: "token-abc"}
	engine := newAuthEngine(svc, domain.RoleAdmin, "loc-1")

	rec := serveJSON(engine, "POST", "/auth/login", `{"email":"admin@thc.local","password":"Password123!"}`)
	mustStatus(t, rec, http.StatusOK)
	data := decodeData[map[string]any](t, mustSuccess(t, rec))
	if data["token"] != "token-abc" {
		t.Fatalf("token = %v, want token-abc", data["token"])
	}
	user, ok := data["user"].(map[string]any)
	if !ok {
		t.Fatalf("login data must carry a user object: %v", data)
	}
	assertSubset(t, "User", user)
	if user["email"] != "admin@thc.local" || user["role"] != "admin" {
		t.Fatalf("user projection wrong: %v", user)
	}
	if user["location_id"] != "loc-1" || user["location_name"] != "Kantor Cabang Surabaya" {
		t.Fatalf("branch projection wrong: %v", user)
	}
	if _, present := user["password_hash"]; present {
		t.Fatal("user projection must never leak the password hash")
	}
}

func TestLogin_InvalidCredentialsReturns401ExactMessage(t *testing.T) {
	svc := &stubAuthService{loginErr: domain.InvalidCredentials()}
	engine := newAuthEngine(svc, domain.RoleAdmin, "loc-1")

	rec := serveJSON(engine, "POST", "/auth/login", `{"email":"nobody@thc.local","password":"wrong"}`)
	mustStatus(t, rec, http.StatusUnauthorized)
	env := decodeEnvelope(t, rec)
	if env.Success {
		t.Fatal("success must be false on invalid credentials")
	}
	if env.Error == nil {
		t.Fatalf("missing error body: %q", rec.Body.String())
	}
	const want = "Kredensial tidak valid"
	if env.Error.Message != want {
		t.Fatalf("message = %q, want byte-for-byte %q", env.Error.Message, want)
	}
}

func TestMe_RequiresBearerToken(t *testing.T) {
	svc := &stubAuthService{profile: cannedAuthProfile()}
	engine := gin.New()
	h := handlers.NewAuthHandler(svc)
	engine.GET("/auth/me",
		middleware.JWT(testParser("secret-a"), svc),
		h.Me,
	)

	rec := serve(engine, "GET", "/auth/me", nil, "")
	mustStatus(t, rec, http.StatusUnauthorized)
	env := decodeEnvelope(t, rec)
	if env.Success || env.Error == nil {
		t.Fatalf("expected failure envelope, got %q", rec.Body.String())
	}
}

func TestMe_RejectsTamperedToken(t *testing.T) {
	mint := testParser("secret-a")
	token, err := mint.Issue(domain.User{ID: "user-1"})
	if err != nil {
		t.Fatalf("mint token: %v", err)
	}
	tampered := token[:len(token)-1] + "x"

	svc := &stubAuthService{profile: cannedAuthProfile()}
	engine := gin.New()
	h := handlers.NewAuthHandler(svc)
	engine.GET("/auth/me",
		middleware.JWT(testParser("secret-b"), svc),
		h.Me,
	)

	rec := serve(engine, "GET", "/auth/me", nil, "")
	mustStatus(t, rec, http.StatusUnauthorized)
	mustStatus(t, serveBearer(engine, tampered), http.StatusUnauthorized)
}

// serveBearer is a tiny local helper: the shared serve helper sets no
// headers, and the tampered-token case needs an Authorization header.
func serveBearer(engine *gin.Engine, token string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/auth/me", bytes.NewReader(nil))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, req)
	return rec
}

func TestResponseEnvelope_MatchesTheMandatedContract(t *testing.T) {
	svc := &stubAuthService{profile: cannedAuthProfile(), token: "token-abc"}
	engine := newAuthEngine(svc, domain.RoleAdmin, "loc-1")

	t.Run("success shape", func(t *testing.T) {
		rec := serveJSON(engine, "POST", "/auth/login", `{"email":"a@thc.local","password":"x"}`)
		mustStatus(t, rec, http.StatusOK)
		raw := rec.Body.String()
		if !strings.Contains(raw, `"success":true`) {
			t.Fatalf("success envelope must carry success:true: %q", raw)
		}
		if strings.Contains(raw, `"error"`) {
			t.Fatalf("success envelope must not carry error: %q", raw)
		}
		var body map[string]any
		if err := json.Unmarshal([]byte(raw), &body); err != nil {
			t.Fatal(err)
		}
		if _, ok := body["data"]; !ok {
			t.Fatalf("success envelope must carry data: %q", raw)
		}
	})

	t.Run("failure shape", func(t *testing.T) {
		bad := &stubAuthService{loginErr: domain.InvalidCredentials()}
		badEngine := newAuthEngine(bad, domain.RoleAdmin, "loc-1")
		rec := serveJSON(badEngine, "POST", "/auth/login", `{"email":"a@thc.local","password":"x"}`)
		mustStatus(t, rec, http.StatusUnauthorized)
		raw := rec.Body.String()
		if !strings.Contains(raw, `"success":false`) {
			t.Fatalf("failure envelope must carry success:false: %q", raw)
		}
		if strings.Contains(raw, `"data"`) {
			t.Fatalf("failure envelope must not carry data: %q", raw)
		}
		var body map[string]any
		if err := json.Unmarshal([]byte(raw), &body); err != nil {
			t.Fatal(err)
		}
		errObj, ok := body["error"].(map[string]any)
		if !ok {
			t.Fatalf("failure envelope must carry error object: %q", raw)
		}
		if errObj["code"] == "" || errObj["message"] == "" {
			t.Fatalf("error needs code+message: %q", raw)
		}
	})
}

// cannedSelfProfile is the projection a successful self-update returns: a
// presigned avatar and the two fields a vendor may edit.
func cannedSelfProfile() auth.Profile {
	p := cannedAuthProfile()
	p.Role = domain.RoleVendor
	p.LocationID = nil
	p.LocationName = nil
	p.AvatarURL = "http://localhost:9000/thc-vms-bucket/profile_photos/pending-actor-1/photo.jpg?X-Amz-Signature=abc"
	p.EditableFields = []string{"phone", "avatar_url"}
	return p
}

func TestPatchMe_ReturnsUpdatedUserProjection(t *testing.T) {
	svc := &stubAuthService{profile: cannedSelfProfile()}
	engine := newAuthEngine(svc, domain.RoleVendor, "")

	rec := serveJSON(engine, "PATCH", "/auth/me", `{"phone":"0812-3456-7890"}`)
	mustStatus(t, rec, http.StatusOK)
	data := decodeData[map[string]any](t, mustSuccess(t, rec))

	if data["avatar_url"] != cannedSelfProfile().AvatarURL {
		t.Fatalf("avatar_url = %v, want the presigned URL", data["avatar_url"])
	}
	fields, ok := data["editable_fields"].([]any)
	if !ok || len(fields) != 2 {
		t.Fatalf("editable_fields = %v, want [phone avatar_url]", data["editable_fields"])
	}
	if svc.updateSelfCalls != 1 {
		t.Fatalf("usecase calls = %d, want exactly 1", svc.updateSelfCalls)
	}
	if svc.lastSelfActor.UserID != domain.UUID("actor-1") || svc.lastSelfActor.Role != domain.RoleVendor {
		t.Fatalf("actor = %+v, want the authenticated caller", svc.lastSelfActor)
	}
	if svc.lastSelfUpdate.Phone == nil || *svc.lastSelfUpdate.Phone != "0812-3456-7890" {
		t.Fatalf("phone not forwarded verbatim: %+v", svc.lastSelfUpdate)
	}
	if svc.lastSelfUpdate.Name != nil || svc.lastSelfUpdate.AvatarURL != nil || svc.lastSelfUpdate.ClearAvatar {
		t.Fatalf("absent members must stay absent: %+v", svc.lastSelfUpdate)
	}
}

func TestPatchMe_RejectsLockedAndUnknownFields(t *testing.T) {
	cases := []struct{ name, body string }{
		{"email", `{"email":"baru@thc.local"}`},
		{"nik", `{"nik":"3201010101010001"}`},
		{"password", `{"password":"Rahasia123!"}`},
		{"role", `{"role":"super_admin"}`},
		{"type", `{"type":"internal"}`},
		{"status", `{"status":"inactive"}`},
		{"location_id", `{"location_id":"loc-1"}`},
		{"vendor_name", `{"vendor_name":"PT Lain"}`},
		{"malformed", `{`},
		{"non object", `[]`},
		{"trailing value", `{"phone":"081234567890"} {"email":"baru@thc.local"}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc := &stubAuthService{profile: cannedSelfProfile()}
			engine := newAuthEngine(svc, domain.RoleSuperAdmin, "")

			rec := serveJSON(engine, "PATCH", "/auth/me", tc.body)
			mustStatus(t, rec, http.StatusBadRequest)
			env := decodeEnvelope(t, rec)
			if env.Success || env.Error == nil || env.Error.Code != "VALIDATION_ERROR" {
				t.Fatalf("body %s must be a 400 VALIDATION_ERROR, got %q", tc.body, rec.Body.String())
			}
			if svc.updateSelfCalls != 0 {
				t.Fatalf("a rejected body must never reach the usecase (calls = %d)", svc.updateSelfCalls)
			}
		})
	}
}

func TestPatchMe_AvatarTriState(t *testing.T) {
	const avatar = "http://localhost:9000/thc-vms-bucket/profile_photos/pending-actor-1/photo.jpg"

	t.Run("null clears", func(t *testing.T) {
		svc := &stubAuthService{profile: cannedSelfProfile()}
		engine := newAuthEngine(svc, domain.RoleVendor, "")

		mustStatus(t, serveJSON(engine, "PATCH", "/auth/me", `{"avatar_url":null}`), http.StatusOK)
		if !svc.lastSelfUpdate.ClearAvatar || svc.lastSelfUpdate.AvatarURL != nil {
			t.Fatalf("null must map to ClearAvatar, got %+v", svc.lastSelfUpdate)
		}
	})

	t.Run("string replaces", func(t *testing.T) {
		svc := &stubAuthService{profile: cannedSelfProfile()}
		engine := newAuthEngine(svc, domain.RoleVendor, "")

		mustStatus(t, serveJSON(engine, "PATCH", "/auth/me", `{"avatar_url":"`+avatar+`"}`), http.StatusOK)
		if svc.lastSelfUpdate.ClearAvatar {
			t.Fatal("a string must not clear the photo")
		}
		if svc.lastSelfUpdate.AvatarURL == nil || *svc.lastSelfUpdate.AvatarURL != avatar {
			t.Fatalf("avatar_url not forwarded: %+v", svc.lastSelfUpdate)
		}
	})

	t.Run("absent keeps", func(t *testing.T) {
		svc := &stubAuthService{profile: cannedSelfProfile()}
		engine := newAuthEngine(svc, domain.RoleVendor, "")

		mustStatus(t, serveJSON(engine, "PATCH", "/auth/me", `{"phone":"081234567890"}`), http.StatusOK)
		if svc.lastSelfUpdate.ClearAvatar || svc.lastSelfUpdate.AvatarURL != nil {
			t.Fatalf("an absent avatar_url must keep the photo, got %+v", svc.lastSelfUpdate)
		}
	})

	t.Run("non string rejected", func(t *testing.T) {
		svc := &stubAuthService{profile: cannedSelfProfile()}
		engine := newAuthEngine(svc, domain.RoleVendor, "")

		mustStatus(t, serveJSON(engine, "PATCH", "/auth/me", `{"avatar_url":123}`), http.StatusBadRequest)
		if svc.updateSelfCalls != 0 {
			t.Fatal("a non-string avatar_url must never reach the usecase")
		}
	})
}

func TestPatchMe_PassesUsecaseRefusalsThrough(t *testing.T) {
	t.Run("403 role-blocked name", func(t *testing.T) {
		const message = "Field name hanya dapat diubah oleh super_admin."
		svc := &stubAuthService{
			profile:       cannedSelfProfile(),
			updateSelfErr: &domain.AppError{Status: http.StatusForbidden, Code: "FORBIDDEN", Message: message},
		}
		engine := newAuthEngine(svc, domain.RoleVendor, "")

		rec := serveJSON(engine, "PATCH", "/auth/me", `{"name":"Nama Baru"}`)
		mustStatus(t, rec, http.StatusForbidden)
		env := decodeEnvelope(t, rec)
		if env.Error == nil || env.Error.Code != "FORBIDDEN" || env.Error.Message != message {
			t.Fatalf("403 envelope not passed through: %q", rec.Body.String())
		}
	})

	t.Run("400 empty patch", func(t *testing.T) {
		svc := &stubAuthService{
			profile:       cannedSelfProfile(),
			updateSelfErr: &domain.AppError{Status: http.StatusBadRequest, Code: "VALIDATION_ERROR", Message: "Tidak ada perubahan yang diberikan."},
		}
		engine := newAuthEngine(svc, domain.RoleVendor, "")

		rec := serveJSON(engine, "PATCH", "/auth/me", `{}`)
		mustStatus(t, rec, http.StatusBadRequest)
		env := decodeEnvelope(t, rec)
		if env.Error == nil || env.Error.Code != "VALIDATION_ERROR" {
			t.Fatalf("empty patch envelope wrong: %q", rec.Body.String())
		}
		if svc.updateSelfCalls != 1 {
			t.Fatalf("an empty object must reach the usecase validation (calls = %d)", svc.updateSelfCalls)
		}
	})
}

func TestPatchMe_RequiresIdentity(t *testing.T) {
	svc := &stubAuthService{profile: cannedSelfProfile()}
	engine := gin.New()
	h := handlers.NewAuthHandler(svc)
	engine.PATCH("/auth/me", h.PatchMe)

	mustStatus(t, serveJSON(engine, "PATCH", "/auth/me", `{"phone":"081234567890"}`), http.StatusUnauthorized)
	if svc.updateSelfCalls != 0 {
		t.Fatal("an unauthenticated patch must never reach the usecase")
	}
}
