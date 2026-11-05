package middleware_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/middleware"
	"thc-vms/backend/internal/domain"
)

func init() {
	gin.SetMode(gin.TestMode)
}

// stubRegisterAudit is a hand-written fake for domain.AuditRepository: it
// records every appended entry so the throttle tests prove the audit row.
type stubRegisterAudit struct {
	mu      sync.Mutex
	entries []domain.AuditEntry
	err     error
}

func (s *stubRegisterAudit) Append(_ context.Context, entry domain.AuditEntry) (domain.AuditLog, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.entries = append(s.entries, entry)
	if s.err != nil {
		return domain.AuditLog{}, s.err
	}
	return domain.AuditLog{}, nil
}

func (s *stubRegisterAudit) List(_ context.Context, _ domain.AuditFilter) ([]domain.AuditLog, int64, error) {
	return nil, 0, nil
}

func (s *stubRegisterAudit) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.entries)
}

func (s *stubRegisterAudit) last() domain.AuditEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.entries[len(s.entries)-1]
}

// testRegisterLimits mirrors production thresholds with a long window so no
// bucket expires mid-test; expiry is covered by its own test below.
func testRegisterLimits() middleware.RegisterLimits {
	return middleware.RegisterLimits{
		PerIP:        5,
		PerTarget:    3,
		IPWindow:     time.Hour,
		TargetWindow: 24 * time.Hour,
	}
}

func newTestRegisterLimiter() (*middleware.RegisterRateLimiter, *stubRegisterAudit) {
	audit := &stubRegisterAudit{}
	return middleware.NewRegisterRateLimiter(testRegisterLimits(), audit), audit
}

func TestRegister_IPBucketTripsIndependently(t *testing.T) {
	limiter, _ := newTestRegisterLimiter()
	// Same IP, but a fresh target email every attempt, so only the per-IP
	// bucket can fill.
	for i := 1; i <= 5; i++ {
		if !limiter.Allow("10.21.0.7", fmt.Sprintf("ip-target-%d@example.com", i)) {
			t.Fatalf("attempt %d from the same IP must pass, only the IP bucket fills", i)
		}
	}
	if limiter.Allow("10.21.0.7", "ip-target-last@example.com") {
		t.Fatal("6th attempt from the same IP must trip the 5/hour per-IP bucket")
	}
}

func TestRegister_TargetBucketTripsIndependently(t *testing.T) {
	limiter, _ := newTestRegisterLimiter()
	// Same target email, but a fresh IP every attempt, so only the
	// per-target-email bucket can fill.
	for i := 1; i <= 3; i++ {
		if !limiter.Allow(fmt.Sprintf("10.22.0.%d", i), "same-target@example.com") {
			t.Fatalf("attempt %d for the same target email must pass, only the target bucket fills", i)
		}
	}
	if limiter.Allow("10.22.0.9", "same-target@example.com") {
		t.Fatal("4th attempt for the same target email must trip the 3/24h per-target bucket")
	}
}

func TestRegister_TargetBucketIsCaseInsensitive(t *testing.T) {
	limiter, _ := newTestRegisterLimiter()
	addrs := []string{"Same-Target@Example.com", "same-target@example.com", "SAME-TARGET@EXAMPLE.COM"}
	for i, addr := range addrs {
		if !limiter.Allow(fmt.Sprintf("10.23.0.%d", i), addr) {
			t.Fatalf("attempt %d with a differently-cased target must share one bucket and pass", i+1)
		}
	}
	if limiter.Allow("10.23.0.9", "same-target@example.com") {
		t.Fatal("4th attempt for the same target email in any case must trip the per-target bucket")
	}
}

func TestRegister_EmptyTargetSkipsTargetBucket(t *testing.T) {
	limiter, _ := newTestRegisterLimiter()
	// A body without an attributable email cannot burn the shared
	// per-target bucket: only the per-IP bucket applies.
	for i := 1; i <= 5; i++ {
		if !limiter.Allow("10.24.0.7", "   ") {
			t.Fatalf("attempt %d with no target email must pass on the IP bucket alone", i)
		}
	}
	if limiter.Allow("10.24.0.7", "") {
		t.Fatal("6th unattributed attempt from the same IP must still trip the per-IP bucket")
	}
	// And unattributed attempts from fresh IPs never trip each other.
	other, _ := newTestRegisterLimiter()
	for i := 1; i <= 10; i++ {
		if !other.Allow(fmt.Sprintf("10.25.0.%d", i), "") {
			t.Fatalf("unattributed attempt %d from a fresh IP must pass", i)
		}
	}
}

func TestRegister_WindowsExpireIndependently(t *testing.T) {
	limits := testRegisterLimits()
	limits.IPWindow = 40 * time.Millisecond
	limits.TargetWindow = 40 * time.Millisecond
	limiter := middleware.NewRegisterRateLimiter(limits, &stubRegisterAudit{})

	for i := 1; i <= 5; i++ {
		if !limiter.Allow("10.26.0.1", fmt.Sprintf("expiry-%d@example.com", i)) {
			t.Fatalf("IP attempt %d must pass before the window fills", i)
		}
	}
	if limiter.Allow("10.26.0.1", "expiry-last@example.com") {
		t.Fatal("6th attempt must trip the per-IP bucket before expiry")
	}
	for i := 1; i <= 3; i++ {
		if !limiter.Allow(fmt.Sprintf("10.27.0.%d", i), "expiry-target@example.com") {
			t.Fatalf("target attempt %d must pass before the window fills", i)
		}
	}
	if limiter.Allow("10.27.0.9", "expiry-target@example.com") {
		t.Fatal("4th attempt must trip the per-target bucket before expiry")
	}

	time.Sleep(60 * time.Millisecond)

	if !limiter.Allow("10.26.0.1", "expiry-last@example.com") {
		t.Fatal("IP attempt must pass again after the window expires")
	}
	if !limiter.Allow("10.27.0.9", "expiry-target@example.com") {
		t.Fatal("target attempt must pass again after the window expires")
	}
}

func TestRegister_ZeroLimitsFallBackToDefaults(t *testing.T) {
	limiter := middleware.NewRegisterRateLimiter(middleware.RegisterLimits{}, &stubRegisterAudit{})
	for i := 1; i <= 5; i++ {
		if !limiter.Allow("10.28.0.1", fmt.Sprintf("fallback-%d@example.com", i)) {
			t.Fatalf("IP attempt %d must pass under the default 5/hour per-IP", i)
		}
	}
	if limiter.Allow("10.28.0.1", "fallback-last@example.com") {
		t.Fatal("6th attempt must trip the defaulted 5/hour per-IP bucket")
	}
	if !limiter.Allow("10.28.0.2", "fallback-target@example.com") ||
		!limiter.Allow("10.28.0.3", "fallback-target@example.com") ||
		!limiter.Allow("10.28.0.4", "fallback-target@example.com") {
		t.Fatal("first three attempts for a target must pass under the default 3/24h per-target")
	}
	if limiter.Allow("10.28.0.5", "fallback-target@example.com") {
		t.Fatal("4th attempt must trip the defaulted 3/24h per-target bucket")
	}
}

// registerEngine mounts the limiter in front of a stub register handler that
// counts how many attempts reach it, proving throttled attempts never touch
// the usecase behind the handler.
func registerEngine(limiter *middleware.RegisterRateLimiter, calls *int) *gin.Engine {
	r := gin.New()
	r.POST("/auth/register", limiter.Middleware(), func(c *gin.Context) {
		*calls++
		c.Status(http.StatusCreated)
	})
	return r
}

func serveRegister(engine *gin.Engine, ip, email string) (int, string) {
	body := fmt.Sprintf(
		`{"name":"Dimas","email":%q,"password":"Password123!","phone":"081234567890","nik":"3201010101900001"}`,
		email,
	)
	req := httptest.NewRequest(http.MethodPost, "/auth/register", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = ip + ":1234"
	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, req)
	return rec.Code, rec.Body.String()
}

const wantRegister429 = `{"success":false,"error":{"code":"RATE_LIMITED","message":"Terlalu banyak percobaan. Silakan coba lagi nanti."}}`

func TestRegister_MiddlewareSixthIPHitIs429WithoutTouchingHandler(t *testing.T) {
	limiter, _ := newTestRegisterLimiter()
	var calls int
	engine := registerEngine(limiter, &calls)

	for i := 1; i <= 5; i++ {
		code, _ := serveRegister(engine, "10.29.0.7", fmt.Sprintf("ip-%d@example.com", i))
		if code != http.StatusCreated {
			t.Fatalf("attempt %d = %d, want 201", i, code)
		}
	}
	code, body := serveRegister(engine, "10.29.0.7", "ip-last@example.com")
	if code != http.StatusTooManyRequests {
		t.Fatalf("6th attempt status = %d, want 429", code)
	}
	if body != wantRegister429 {
		t.Fatalf("429 body = %q, want byte-exact %q", body, wantRegister429)
	}
	if calls != 5 {
		t.Fatalf("handler calls = %d, want 5: the throttled attempt must never reach the usecase", calls)
	}
}

func TestRegister_MiddlewareFourthSameEmailIs429WithAuditRow(t *testing.T) {
	limiter, audit := newTestRegisterLimiter()
	var calls int
	engine := registerEngine(limiter, &calls)

	for i := 1; i <= 3; i++ {
		code, _ := serveRegister(engine, fmt.Sprintf("10.30.0.%d", i), "korban@example.com")
		if code != http.StatusCreated {
			t.Fatalf("attempt %d = %d, want 201", i, code)
		}
	}
	code, body := serveRegister(engine, "10.30.0.9", "korban@example.com")
	if code != http.StatusTooManyRequests {
		t.Fatalf("4th same-email attempt status = %d, want 429", code)
	}
	if body != wantRegister429 {
		t.Fatalf("429 body = %q, want byte-exact %q", body, wantRegister429)
	}
	if calls != 3 {
		t.Fatalf("handler calls = %d, want 3: the throttled attempt must never reach the usecase", calls)
	}
	if audit.count() != 1 {
		t.Fatalf("audit rows = %d, want exactly 1 on throttle", audit.count())
	}
	entry := audit.last()
	if entry.Action != domain.AuditActionLoginFailed {
		t.Fatalf("audit action = %q, want %q", entry.Action, domain.AuditActionLoginFailed)
	}
	if entry.Metadata["email"] != "korban@example.com" {
		t.Fatalf("audit email = %q, want the throttled target", entry.Metadata["email"])
	}
	if entry.Metadata["reason"] != "rate_limited" {
		t.Fatalf("audit reason = %q, want rate_limited", entry.Metadata["reason"])
	}
	if entry.IP == "" {
		t.Fatal("audit row must carry the client IP")
	}
	if _, ok := entry.Metadata["password"]; ok {
		t.Fatal("audit metadata must never carry secrets")
	}
}

func TestRegister_MiddlewareAuditFailureStillAnswers429(t *testing.T) {
	audit := &stubRegisterAudit{err: context.DeadlineExceeded}
	limiter := middleware.NewRegisterRateLimiter(testRegisterLimits(), audit)
	var calls int
	engine := registerEngine(limiter, &calls)

	for i := 1; i <= 3; i++ {
		serveRegister(engine, fmt.Sprintf("10.31.0.%d", i), "audit-down@example.com")
	}
	code, body := serveRegister(engine, "10.31.0.9", "audit-down@example.com")
	if code != http.StatusTooManyRequests || body != wantRegister429 {
		t.Fatalf("throttle with a failing audit store must still answer the frozen 429, got %d %q", code, body)
	}
	if calls != 3 {
		t.Fatalf("handler calls = %d, want 3: the throttled attempt must never reach the usecase", calls)
	}
}
