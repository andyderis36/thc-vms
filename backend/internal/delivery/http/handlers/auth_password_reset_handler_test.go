package handlers_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/handlers"
	"thc-vms/backend/internal/domain"
)

// stubPasswordResetService is a hand-written fake for
// handlers.PasswordResetService: no mocking library, no testify. A nil error
// models the silent unknown-email success (NO row, NO mail at the usecase
// layer); the handler cannot tell it apart from a mailed reset, which is the
// whole anti-enumeration point.
type stubPasswordResetService struct {
	requestErr   error
	requestCalls int
	lastReqEmail string
	lastReqIP    string

	confirmErr   error
	confirmCalls int
	lastToken    string
	lastPassword string
}

func (s *stubPasswordResetService) RequestPasswordReset(_ context.Context, email, ip string) error {
	s.requestCalls++
	s.lastReqEmail = email
	s.lastReqIP = ip
	return s.requestErr
}

func (s *stubPasswordResetService) ConfirmPasswordReset(_ context.Context, rawToken, newPassword string) error {
	s.confirmCalls++
	s.lastToken = rawToken
	s.lastPassword = newPassword
	return s.confirmErr
}

// stubPasswordResetLimiter is a hand-written fake for
// handlers.PasswordResetLimiter. It allows everything until a test flips a
// direction off, and records every consultation (including the target email
// the request bucket keys on) so the limiter-second order is observable.
type stubPasswordResetLimiter struct {
	allowRequest bool
	allowConfirm bool

	requestCalls int
	lastReqIP    string
	lastTarget   string

	confirmCalls int
	lastConfIP   string
}

func openPasswordResetLimiter() *stubPasswordResetLimiter {
	return &stubPasswordResetLimiter{allowRequest: true, allowConfirm: true}
}

func (l *stubPasswordResetLimiter) AllowRequest(ip, targetEmail string) bool {
	l.requestCalls++
	l.lastReqIP, l.lastTarget = ip, targetEmail
	return l.allowRequest
}

func (l *stubPasswordResetLimiter) AllowConfirm(ip string) bool {
	l.confirmCalls++
	l.lastConfIP = ip
	return l.allowConfirm
}

// newPasswordResetEngine mounts the handler WITHOUT any identity middleware:
// both endpoints are PUBLIC (the caller cannot log in, that is the point).
func newPasswordResetEngine(svc *stubPasswordResetService, limiter *stubPasswordResetLimiter) *gin.Engine {
	engine := gin.New()
	h := handlers.NewPasswordResetHandler(svc, limiter)
	engine.POST("/auth/password-reset/request", h.RequestPasswordReset)
	engine.POST("/auth/password-reset/confirm", h.ConfirmPasswordReset)
	return engine
}

// genericResetLinkErrorBody renders one confirm failure through the engine so
// uniformity tests can compare full wire bytes, not just code/message.
func genericResetLinkErrorBody(t *testing.T, svcErr error) string {
	t.Helper()
	svc := &stubPasswordResetService{confirmErr: svcErr}
	engine := newPasswordResetEngine(svc, openPasswordResetLimiter())

	rec := serveJSON(engine, "POST", "/auth/password-reset/confirm", `{"token":"opaque-token","new_password":"Baru12345!"}`)
	mustStatus(t, rec, http.StatusUnauthorized)
	env := decodeEnvelope(t, rec)
	if env.Success || env.Error == nil {
		t.Fatalf("confirm failure must be the failure envelope, got %q", rec.Body.String())
	}
	if env.Error.Code != "UNAUTHORIZED" || env.Error.Message != "Tautan tidak valid atau kedaluwarsa." {
		t.Fatalf("confirm failure = %s/%q, want UNAUTHORIZED/link message", env.Error.Code, env.Error.Message)
	}
	return rec.Body.String()
}

func TestPasswordResetRequest_StrictBodyRejected(t *testing.T) {
	cases := []struct{ name, body string }{
		{"legacy email key", `{"new_email":"baru@example.com"}`},
		{"extra key", `{"email":"baru@example.com","role":"super_admin"}`},
		{"malformed", `{`},
		{"non object", `[]`},
		{"trailing value", `{"email":"baru@example.com"} {"token":"x"}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc := &stubPasswordResetService{}
			limiter := openPasswordResetLimiter()
			engine := newPasswordResetEngine(svc, limiter)

			rec := serveJSON(engine, "POST", "/auth/password-reset/request", tc.body)
			mustStatus(t, rec, http.StatusBadRequest)
			env := decodeEnvelope(t, rec)
			if env.Success || env.Error == nil || env.Error.Code != "VALIDATION_ERROR" {
				t.Fatalf("body %s must be a 400 VALIDATION_ERROR, got %q", tc.body, rec.Body.String())
			}
			if svc.requestCalls != 0 {
				t.Fatalf("a rejected body must never reach the usecase (calls = %d)", svc.requestCalls)
			}
			if limiter.requestCalls != 0 {
				t.Fatalf("a rejected body must never burn rate-limit budget (calls = %d)", limiter.requestCalls)
			}
		})
	}
}

func TestPasswordResetRequest_BadShapeIs422(t *testing.T) {
	for _, tc := range []struct{ name, body string }{
		{"empty email", `{"email":""}`},
		{"blank email", `{"email":"   "}`},
		{"not an email", `{"email":"bukan-email"}`},
		{"display name", `{"email":"Andi <andi@example.com>"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc := &stubPasswordResetService{}
			limiter := openPasswordResetLimiter()
			engine := newPasswordResetEngine(svc, limiter)

			rec := serveJSON(engine, "POST", "/auth/password-reset/request", tc.body)
			mustStatus(t, rec, http.StatusUnprocessableEntity)
			env := decodeEnvelope(t, rec)
			if env.Success || env.Error == nil || env.Error.Code != "VALIDATION_ERROR" {
				t.Fatalf("body %s must be a 422 VALIDATION_ERROR, got %q", tc.body, rec.Body.String())
			}
			if svc.requestCalls != 0 {
				t.Fatalf("a bad shape must never reach the usecase (calls = %d)", svc.requestCalls)
			}
		})
	}
}

func TestPasswordResetRequest_SuccessIs202Generic(t *testing.T) {
	svc := &stubPasswordResetService{}
	limiter := openPasswordResetLimiter()
	engine := newPasswordResetEngine(svc, limiter)

	rec := serveJSON(engine, "POST", "/auth/password-reset/request", `{"email":"vendor@thc.local"}`)
	mustStatus(t, rec, http.StatusAccepted)
	data := decodeData[map[string]any](t, mustSuccess(t, rec))
	if len(data) != 1 || data["message"] != "Jika email terdaftar, tautan reset kata sandi telah dikirim." {
		t.Fatalf("202 data = %v, want exactly the generic message member", data)
	}
	if svc.requestCalls != 1 || svc.lastReqEmail != "vendor@thc.local" {
		t.Fatalf("request not forwarded verbatim: email = %q (calls = %d)", svc.lastReqEmail, svc.requestCalls)
	}
	if limiter.requestCalls != 1 || limiter.lastTarget != "vendor@thc.local" {
		t.Fatalf("limiter must see the target email first (calls = %d, target = %q)", limiter.requestCalls, limiter.lastTarget)
	}
}

func TestPasswordResetRequest_UnknownEmailIsSame202(t *testing.T) {
	// Unknown emails succeed silently: the SAME 202 with the SAME bytes as a
	// mailed reset, so the endpoint never becomes an account oracle. The stub
	// models the usecase silence (nil error, NO row, NO mail); the handler
	// must not distinguish it.
	svc := &stubPasswordResetService{}
	engine := newPasswordResetEngine(svc, openPasswordResetLimiter())

	rec := serveJSON(engine, "POST", "/auth/password-reset/request", `{"email":"tidak-ada@example.com"}`)
	mustStatus(t, rec, http.StatusAccepted)
	data := decodeData[map[string]any](t, mustSuccess(t, rec))
	if len(data) != 1 || data["message"] != "Jika email terdaftar, tautan reset kata sandi telah dikirim." {
		t.Fatalf("unknown-email 202 data = %v, want exactly the generic message member", data)
	}
	if svc.requestCalls != 1 {
		t.Fatalf("the usecase still owns the silence decision (calls = %d)", svc.requestCalls)
	}
}

func TestPasswordResetRequest_GatedAccountsPassthrough(t *testing.T) {
	for _, tc := range []struct {
		name   string
		svcErr error
		code   string
	}{
		{"inactive", domain.AccountInactive(), "ACCOUNT_INACTIVE"},
		{"pending", domain.AccountPending(), "ACCOUNT_PENDING"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc := &stubPasswordResetService{requestErr: tc.svcErr}
			engine := newPasswordResetEngine(svc, openPasswordResetLimiter())

			rec := serveJSON(engine, "POST", "/auth/password-reset/request", `{"email":"vendor@thc.local"}`)
			mustStatus(t, rec, http.StatusForbidden)
			env := decodeEnvelope(t, rec)
			if env.Error == nil || env.Error.Code != tc.code {
				t.Fatalf("gated account must pass through as 403 %s, got %q", tc.code, rec.Body.String())
			}
		})
	}
}

func TestPasswordResetRequest_RateLimited(t *testing.T) {
	svc := &stubPasswordResetService{}
	limiter := openPasswordResetLimiter()
	limiter.allowRequest = false
	engine := newPasswordResetEngine(svc, limiter)

	rec := serveJSON(engine, "POST", "/auth/password-reset/request", `{"email":"vendor@thc.local"}`)
	mustStatus(t, rec, http.StatusTooManyRequests)
	env := decodeEnvelope(t, rec)
	if env.Error == nil || env.Error.Code != "RATE_LIMITED" {
		t.Fatalf("throttled request must be the frozen 429 envelope, got %q", rec.Body.String())
	}
	if svc.requestCalls != 0 {
		t.Fatalf("a throttled request must never reach the usecase (calls = %d)", svc.requestCalls)
	}
}

func TestPasswordResetConfirm_SuccessIs200Generic(t *testing.T) {
	svc := &stubPasswordResetService{}
	limiter := openPasswordResetLimiter()
	engine := newPasswordResetEngine(svc, limiter)

	rec := serveJSON(engine, "POST", "/auth/password-reset/confirm", `{"token":"opaque-token","new_password":"Baru12345!"}`)
	mustStatus(t, rec, http.StatusOK)
	data := decodeData[map[string]any](t, mustSuccess(t, rec))
	if len(data) != 1 || data["message"] != "Kata sandi berhasil diubah. Silakan masuk dengan kata sandi baru." {
		t.Fatalf("200 data = %v, want exactly the generic message member", data)
	}
	if svc.confirmCalls != 1 || svc.lastToken != "opaque-token" || svc.lastPassword != "Baru12345!" {
		t.Fatalf("confirm not forwarded verbatim: token set = %v, password set = %v (calls = %d)",
			svc.lastToken != "", svc.lastPassword != "", svc.confirmCalls)
	}
	if limiter.confirmCalls != 1 {
		t.Fatalf("limiter must see the confirm (calls = %d)", limiter.confirmCalls)
	}
}

func TestPasswordResetConfirm_ErrorsAreIndistinguishable(t *testing.T) {
	// Expired, consumed, tampered, unknown and even wiring failures must
	// render byte-identical bodies: the endpoint can never become an account
	// oracle.
	errs := map[string]error{
		"expired":  domain.PasswordResetLinkInvalid(),
		"consumed": domain.PasswordResetLinkInvalid(),
		"tampered": domain.PasswordResetLinkInvalid(),
		"unknown":  domain.ErrNotFound,
		"wiring":   &domain.AppError{Status: http.StatusInternalServerError, Code: "INTERNAL_ERROR", Message: "Terjadi kesalahan pada server."},
		"wrapped":  domain.FromError(domain.ErrUnauthorized),
	}
	var want string
	for name, svcErr := range errs {
		got := genericResetLinkErrorBody(t, svcErr)
		if want == "" {
			want = got
		}
		if got != want {
			t.Fatalf("%s body differs: %q vs %q", name, got, want)
		}
	}
}

func TestPasswordResetConfirm_StrictBodyRejectedAsInvalidLink(t *testing.T) {
	want := genericResetLinkErrorBody(t, domain.PasswordResetLinkInvalid())
	for _, tc := range []struct{ name, body string }{
		{"extra key", `{"token":"opaque-token","new_password":"Baru12345!","email":"x@example.com"}`},
		{"missing token", `{"new_password":"Baru12345!"}`},
		{"missing password", `{"token":"opaque-token"}`},
		{"empty token", `{"token":"","new_password":"Baru12345!"}`},
		{"blank token", `{"token":"   ","new_password":"Baru12345!"}`},
		{"empty password", `{"token":"opaque-token","new_password":""}`},
		{"blank password", `{"token":"opaque-token","new_password":"   "}`},
		{"malformed", `{`},
		{"non object", `[]`},
		{"trailing value", `{"token":"opaque-token","new_password":"Baru12345!"} {"token":"other"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc := &stubPasswordResetService{}
			limiter := openPasswordResetLimiter()
			engine := newPasswordResetEngine(svc, limiter)

			rec := serveJSON(engine, "POST", "/auth/password-reset/confirm", tc.body)
			mustStatus(t, rec, http.StatusUnauthorized)
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

func TestPasswordResetConfirm_WeakPasswordPassthrough(t *testing.T) {
	svc := &stubPasswordResetService{
		confirmErr: &domain.AppError{Status: http.StatusBadRequest, Code: "VALIDATION_ERROR", Message: "Kata sandi minimal 8 karakter."},
	}
	engine := newPasswordResetEngine(svc, openPasswordResetLimiter())

	rec := serveJSON(engine, "POST", "/auth/password-reset/confirm", `{"token":"opaque-token","new_password":"lemah"}`)
	mustStatus(t, rec, http.StatusBadRequest)
	env := decodeEnvelope(t, rec)
	if env.Error == nil || env.Error.Code != "VALIDATION_ERROR" || env.Error.Message != "Kata sandi minimal 8 karakter." {
		t.Fatalf("weak password must pass through as 400 VALIDATION_ERROR, got %q", rec.Body.String())
	}
}

func TestPasswordResetConfirm_RateLimited(t *testing.T) {
	svc := &stubPasswordResetService{}
	limiter := openPasswordResetLimiter()
	limiter.allowConfirm = false
	engine := newPasswordResetEngine(svc, limiter)

	rec := serveJSON(engine, "POST", "/auth/password-reset/confirm", `{"token":"opaque-token","new_password":"Baru12345!"}`)
	mustStatus(t, rec, http.StatusTooManyRequests)
	env := decodeEnvelope(t, rec)
	if env.Error == nil || env.Error.Code != "RATE_LIMITED" {
		t.Fatalf("throttled confirm must be the frozen 429 envelope, got %q", rec.Body.String())
	}
	if svc.confirmCalls != 0 {
		t.Fatalf("a throttled confirm must never reach the usecase (calls = %d)", svc.confirmCalls)
	}
}

func TestPasswordResetConfirm_NeedsNoIdentity(t *testing.T) {
	// The endpoints are PUBLIC by design: no Authorization header, no
	// identity middleware, yet the request still reaches the usecase.
	svc := &stubPasswordResetService{}
	engine := newPasswordResetEngine(svc, openPasswordResetLimiter())

	rec := serveJSON(engine, "POST", "/auth/password-reset/confirm", `{"token":"opaque-token","new_password":"Baru12345!"}`)
	mustStatus(t, rec, http.StatusOK)
	if svc.confirmCalls != 1 {
		t.Fatalf("a public confirm must reach the usecase (calls = %d)", svc.confirmCalls)
	}
}
