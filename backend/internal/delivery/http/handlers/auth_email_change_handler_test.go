package handlers_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/handlers"
	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/auth"
)

// stubEmailChangeService is a hand-written fake for
// handlers.EmailChangeService: no mocking library, no testify. The request
// path resolves the caller's stored address through Me (the frozen request
// body carries no old address), so the fake records that lookup too.
type stubEmailChangeService struct {
	meProfile auth.Profile
	meErr     error
	meCalls   int
	lastMeID  domain.UUID

	requestToken string
	requestErr   error
	requestCalls int
	lastReqUser  domain.UUID
	lastOldEmail string
	lastNewEmail string
	lastPassword string

	confirmProfile auth.Profile
	confirmErr     error
	confirmCalls   int
	lastConfirmUID domain.UUID
	lastToken      string
}

func (s *stubEmailChangeService) Me(_ context.Context, id domain.UUID) (auth.Profile, error) {
	s.meCalls++
	s.lastMeID = id
	if s.meErr != nil {
		return auth.Profile{}, s.meErr
	}
	return s.meProfile, nil
}

func (s *stubEmailChangeService) RequestEmailChange(_ context.Context, userID domain.UUID, oldEmail, newEmail, currentPassword string) (string, error) {
	s.requestCalls++
	s.lastReqUser = userID
	s.lastOldEmail = oldEmail
	s.lastNewEmail = newEmail
	s.lastPassword = currentPassword
	if s.requestErr != nil {
		return "", s.requestErr
	}
	return s.requestToken, nil
}

func (s *stubEmailChangeService) ConfirmEmailChange(_ context.Context, userID domain.UUID, token string) (auth.Profile, error) {
	s.confirmCalls++
	s.lastConfirmUID = userID
	s.lastToken = token
	if s.confirmErr != nil {
		return auth.Profile{}, s.confirmErr
	}
	return s.confirmProfile, nil
}

// stubEmailChangeLimiter is a hand-written fake for
// handlers.EmailChangeLimiter. It allows everything until a test flips a
// direction off, and records every consultation (including the target email
// the request bucket keys on) so the limiter-first order is observable.
type stubEmailChangeLimiter struct {
	allowRequest bool
	allowConfirm bool

	requestCalls int
	lastReqUser  string
	lastReqIP    string
	lastTarget   string

	confirmCalls int
	lastConfUser string
	lastConfIP   string
}

func openEmailChangeLimiter() *stubEmailChangeLimiter {
	return &stubEmailChangeLimiter{allowRequest: true, allowConfirm: true}
}

func (l *stubEmailChangeLimiter) AllowRequest(userID, ip, targetEmail string) bool {
	l.requestCalls++
	l.lastReqUser, l.lastReqIP, l.lastTarget = userID, ip, targetEmail
	return l.allowRequest
}

func (l *stubEmailChangeLimiter) AllowConfirm(userID, ip string) bool {
	l.confirmCalls++
	l.lastConfUser, l.lastConfIP = userID, ip
	return l.allowConfirm
}

func newEmailChangeEngine(svc *stubEmailChangeService, limiter *stubEmailChangeLimiter) *gin.Engine {
	engine := gin.New()
	engine.Use(withActor(domain.RoleAdmin, "loc-1"))
	h := handlers.NewEmailChangeHandler(svc, limiter)
	engine.POST("/auth/email-change/request", h.RequestEmailChange)
	engine.POST("/auth/email-change/confirm", h.ConfirmEmailChange)
	return engine
}

func cannedEmailChangeProfile() auth.Profile {
	return cannedAuthProfile()
}

// genericLinkErrorBody renders one confirm failure through the engine so
// uniformity tests can compare full wire bytes, not just code/message.
func genericLinkErrorBody(t *testing.T, svcErr error) string {
	t.Helper()
	svc := &stubEmailChangeService{confirmErr: svcErr}
	engine := newEmailChangeEngine(svc, openEmailChangeLimiter())

	rec := serveJSON(engine, "POST", "/auth/email-change/confirm", `{"token":"opaque-token"}`)
	mustStatus(t, rec, http.StatusBadRequest)
	env := decodeEnvelope(t, rec)
	if env.Success || env.Error == nil {
		t.Fatalf("confirm failure must be the failure envelope, got %q", rec.Body.String())
	}
	if env.Error.Code != "INVALID_TOKEN" || env.Error.Message != "Tautan tidak valid atau kedaluwarsa." {
		t.Fatalf("confirm failure = %s/%q, want INVALID_TOKEN/link message", env.Error.Code, env.Error.Message)
	}
	return rec.Body.String()
}

func TestEmailChangeRequest_StrictBodyRejected(t *testing.T) {
	cases := []struct{ name, body string }{
		{"legacy email key", `{"email":"baru@example.com","current_password":"Password123!"}`},
		{"extra key", `{"new_email":"baru@example.com","current_password":"Password123!","role":"super_admin"}`},
		{"malformed", `{`},
		{"non object", `[]`},
		{"trailing value", `{"new_email":"baru@example.com","current_password":"Password123!"} {"token":"x"}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc := &stubEmailChangeService{}
			limiter := openEmailChangeLimiter()
			engine := newEmailChangeEngine(svc, limiter)

			rec := serveJSON(engine, "POST", "/auth/email-change/request", tc.body)
			mustStatus(t, rec, http.StatusBadRequest)
			env := decodeEnvelope(t, rec)
			if env.Success || env.Error == nil || env.Error.Code != "VALIDATION_ERROR" {
				t.Fatalf("body %s must be a 400 VALIDATION_ERROR, got %q", tc.body, rec.Body.String())
			}
			if svc.meCalls != 0 || svc.requestCalls != 0 {
				t.Fatalf("a rejected body must never reach the usecase (me = %d, request = %d)", svc.meCalls, svc.requestCalls)
			}
			if limiter.requestCalls != 0 {
				t.Fatalf("a rejected body must never burn rate-limit budget (calls = %d)", limiter.requestCalls)
			}
		})
	}
}

func TestEmailChangeRequest_SuccessIs202Generic(t *testing.T) {
	svc := &stubEmailChangeService{
		meProfile:    auth.Profile{Email: "self@thc.local"},
		requestToken: "opaque-token",
	}
	limiter := openEmailChangeLimiter()
	engine := newEmailChangeEngine(svc, limiter)

	rec := serveJSON(engine, "POST", "/auth/email-change/request", `{"new_email":"baru@example.com","current_password":"Password123!"}`)
	mustStatus(t, rec, http.StatusAccepted)
	data := decodeData[map[string]any](t, mustSuccess(t, rec))
	if len(data) != 1 || data["message"] != "Tautan verifikasi telah dikirim ke email baru Anda." {
		t.Fatalf("202 data = %v, want exactly the generic message member", data)
	}
	if svc.meCalls != 1 || svc.lastMeID != "actor-1" {
		t.Fatalf("stored address must resolve through Me once for actor-1 (calls = %d, id = %q)", svc.meCalls, svc.lastMeID)
	}
	if svc.requestCalls != 1 || svc.lastReqUser != "actor-1" || svc.lastOldEmail != "self@thc.local" ||
		svc.lastNewEmail != "baru@example.com" || svc.lastPassword != "Password123!" {
		t.Fatalf("request not forwarded verbatim: user = %q, old = %q, new = %q, password set = %v",
			svc.lastReqUser, svc.lastOldEmail, svc.lastNewEmail, svc.lastPassword != "")
	}
	if limiter.requestCalls != 1 || limiter.lastTarget != "baru@example.com" {
		t.Fatalf("limiter must see the target email first (calls = %d, target = %q)", limiter.requestCalls, limiter.lastTarget)
	}
}

func TestEmailChangeRequest_WrongPasswordPassthrough(t *testing.T) {
	svc := &stubEmailChangeService{
		meProfile:  auth.Profile{Email: "self@thc.local"},
		requestErr: &domain.AppError{Status: http.StatusUnauthorized, Code: "INVALID_CREDENTIALS", Message: "Password saat ini salah."},
	}
	engine := newEmailChangeEngine(svc, openEmailChangeLimiter())

	rec := serveJSON(engine, "POST", "/auth/email-change/request", `{"new_email":"baru@example.com","current_password":"WrongPassword!"}`)
	mustStatus(t, rec, http.StatusUnauthorized)
	env := decodeEnvelope(t, rec)
	if env.Error == nil || env.Error.Code != "INVALID_CREDENTIALS" || env.Error.Message != "Password saat ini salah." {
		t.Fatalf("401 envelope not passed through: %q", rec.Body.String())
	}
}

func TestEmailChangeRequest_RateLimited(t *testing.T) {
	svc := &stubEmailChangeService{meProfile: auth.Profile{Email: "self@thc.local"}}
	limiter := openEmailChangeLimiter()
	limiter.allowRequest = false
	engine := newEmailChangeEngine(svc, limiter)

	rec := serveJSON(engine, "POST", "/auth/email-change/request", `{"new_email":"baru@example.com","current_password":"Password123!"}`)
	mustStatus(t, rec, http.StatusTooManyRequests)
	env := decodeEnvelope(t, rec)
	if env.Error == nil || env.Error.Code != "RATE_LIMITED" {
		t.Fatalf("throttled request must be the frozen 429 envelope, got %q", rec.Body.String())
	}
	if svc.meCalls != 0 || svc.requestCalls != 0 {
		t.Fatalf("a throttled request must never reach the usecase (me = %d, request = %d)", svc.meCalls, svc.requestCalls)
	}
}

func TestEmailChangeRequest_RequiresIdentity(t *testing.T) {
	svc := &stubEmailChangeService{}
	engine := gin.New()
	h := handlers.NewEmailChangeHandler(svc, openEmailChangeLimiter())
	engine.POST("/auth/email-change/request", h.RequestEmailChange)

	mustStatus(t, serveJSON(engine, "POST", "/auth/email-change/request", `{"new_email":"baru@example.com","current_password":"Password123!"}`), http.StatusUnauthorized)
	if svc.meCalls != 0 || svc.requestCalls != 0 {
		t.Fatal("an unauthenticated request must never reach the usecase")
	}
}

func TestEmailChangeConfirm_SuccessIs200User(t *testing.T) {
	svc := &stubEmailChangeService{confirmProfile: cannedEmailChangeProfile()}
	engine := newEmailChangeEngine(svc, openEmailChangeLimiter())

	rec := serveJSON(engine, "POST", "/auth/email-change/confirm", `{"token":"opaque-token"}`)
	mustStatus(t, rec, http.StatusOK)
	data := asObject(t, mustSuccess(t, rec).Data)
	assertSubset(t, "User", data)
	if data["email"] != "admin@thc.local" {
		t.Fatalf("confirm user email = %v, want the flipped profile", data["email"])
	}
	if svc.confirmCalls != 1 || svc.lastConfirmUID != "actor-1" || svc.lastToken != "opaque-token" {
		t.Fatalf("confirm not forwarded verbatim: user = %q, token set = %v", svc.lastConfirmUID, svc.lastToken != "")
	}
}

func TestEmailChangeConfirm_ErrorsAreIndistinguishable(t *testing.T) {
	// Stale-row, cross-user, expired/tampered, taken-address and even wiring
	// failures must render byte-identical bodies: the endpoint can never
	// become an account oracle.
	errs := map[string]error{
		"stale":      &domain.AppError{Status: http.StatusUnauthorized, Code: "UNAUTHORIZED", Message: "Tautan tidak valid atau kedaluwarsa."},
		"wrong user": &domain.AppError{Status: http.StatusUnauthorized, Code: "UNAUTHORIZED", Message: "Tautan tidak valid atau kedaluwarsa."},
		"expired":    &domain.AppError{Status: http.StatusUnauthorized, Code: "UNAUTHORIZED", Message: "Tautan tidak valid atau kedaluwarsa."},
		"taken":      &domain.AppError{Status: http.StatusUnauthorized, Code: "UNAUTHORIZED", Message: "Tautan tidak valid atau kedaluwarsa."},
		"conflict":   &domain.AppError{Status: http.StatusConflict, Code: "CONFLICT", Message: "Email sudah digunakan."},
		"gone":       domain.ErrNotFound,
		"broken":     &domain.AppError{Status: http.StatusInternalServerError, Code: "INTERNAL_ERROR", Message: "Terjadi kesalahan pada server."},
	}
	var want string
	for name, svcErr := range errs {
		got := genericLinkErrorBody(t, svcErr)
		if want == "" {
			want = got
		}
		if got != want {
			t.Fatalf("%s body differs: %q vs %q", name, got, want)
		}
	}
}

func TestEmailChangeConfirm_StrictBodyRejectedAsInvalidToken(t *testing.T) {
	want := genericLinkErrorBody(t, &domain.AppError{Status: http.StatusUnauthorized, Code: "UNAUTHORIZED", Message: "Tautan tidak valid atau kedaluwarsa."})
	for _, tc := range []struct{ name, body string }{
		{"extra key", `{"token":"opaque-token","email":"baru@example.com"}`},
		{"missing token", `{}`},
		{"empty token", `{"token":""}`},
		{"blank token", `{"token":"   "}`},
		{"malformed", `{`},
		{"non object", `[]`},
		{"trailing value", `{"token":"opaque-token"} {"token":"other"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc := &stubEmailChangeService{}
			limiter := openEmailChangeLimiter()
			engine := newEmailChangeEngine(svc, limiter)

			rec := serveJSON(engine, "POST", "/auth/email-change/confirm", tc.body)
			mustStatus(t, rec, http.StatusBadRequest)
			if rec.Body.String() != want {
				t.Fatalf("body %s renders %q, want the generic link error %q", tc.body, rec.Body.String(), want)
			}
			if svc.confirmCalls != 0 {
				t.Fatalf("a rejected body must never reach the usecase (calls = %d)", svc.confirmCalls)
			}
			if limiter.confirmCalls != 0 {
				t.Fatalf("a rejected body must never burn rate-limit budget (calls = %d)", limiter.confirmCalls)
			}
		})
	}
}

func TestEmailChangeConfirm_RateLimited(t *testing.T) {
	svc := &stubEmailChangeService{confirmProfile: cannedEmailChangeProfile()}
	limiter := openEmailChangeLimiter()
	limiter.allowConfirm = false
	engine := newEmailChangeEngine(svc, limiter)

	rec := serveJSON(engine, "POST", "/auth/email-change/confirm", `{"token":"opaque-token"}`)
	mustStatus(t, rec, http.StatusTooManyRequests)
	env := decodeEnvelope(t, rec)
	if env.Error == nil || env.Error.Code != "RATE_LIMITED" {
		t.Fatalf("throttled confirm must be the frozen 429 envelope, got %q", rec.Body.String())
	}
	if svc.confirmCalls != 0 {
		t.Fatalf("a throttled confirm must never reach the usecase (calls = %d)", svc.confirmCalls)
	}
}

func TestEmailChangeConfirm_RequiresIdentity(t *testing.T) {
	svc := &stubEmailChangeService{}
	limiter := openEmailChangeLimiter()
	engine := gin.New()
	h := handlers.NewEmailChangeHandler(svc, limiter)
	engine.POST("/auth/email-change/confirm", h.ConfirmEmailChange)

	mustStatus(t, serveJSON(engine, "POST", "/auth/email-change/confirm", `{"token":"opaque-token"}`), http.StatusUnauthorized)
	if svc.confirmCalls != 0 {
		t.Fatal("an unauthenticated confirm must never reach the usecase")
	}
	if limiter.confirmCalls != 0 {
		t.Fatal("an unauthenticated confirm must never burn rate-limit budget")
	}
}
