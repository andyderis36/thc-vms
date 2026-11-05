package mailer

import (
	"context"
	"errors"
	"io"
	"sync/atomic"
	"testing"
	"time"

	mail "github.com/wneessen/go-mail"

	"thc-vms/backend/internal/config"
)

// timeoutError is a fake network timeout: a net.Error whose Timeout is true.
type timeoutError struct{}

func (timeoutError) Error() string   { return "dial tcp 10.0.0.1:465: i/o timeout" }
func (timeoutError) Timeout() bool   { return true }
func (timeoutError) Temporary() bool { return true }

func testMailConfig() *config.Config {
	return &config.Config{
		Mail: config.Mail{
			Enabled:  true,
			Host:     "smtp.example.com",
			Port:     465,
			User:     "bot@example.com",
			Password: "secret",
			From:     "noreply@example.com",
			Timeout:  30 * time.Second,
		},
	}
}

// stubSend fails failsLeft times with stubErr, then succeeds. Calls are counted.
type stubSender struct {
	calls     atomic.Int64
	failsLeft atomic.Int64
	stubErr   error
	delivered chan struct{}
}

func (s *stubSender) send(context.Context, *mail.Msg) error {
	n := s.calls.Add(1)
	_ = n
	if s.delivered != nil && s.failsLeft.Load() <= 0 {
		select {
		case s.delivered <- struct{}{}:
		default:
		}
	}
	if s.failsLeft.Add(-1) >= 0 {
		return s.stubErr
	}
	return nil
}

func TestNew_NilConfigFailsFast(t *testing.T) {
	if _, err := New(nil); err == nil {
		t.Fatal("New(nil) = nil error, want fail-fast error")
	}
}

func TestNew_EnabledEmptyHostFailsFast(t *testing.T) {
	cfg := &config.Config{Mail: config.Mail{Enabled: true, Host: ""}}
	if _, err := New(cfg); err == nil {
		t.Fatal("New(enabled, empty host) = nil error, want fail-fast error")
	}
}

func TestNew_FromFallsBackToUser(t *testing.T) {
	cfg := testMailConfig()
	cfg.Mail.From = ""
	m, err := New(cfg)
	if err != nil {
		t.Fatalf("New = %v", err)
	}
	defer m.Close()
	if m.from != "bot@example.com" {
		t.Fatalf("from = %q, want User fallback %q", m.from, "bot@example.com")
	}
}

func TestNew_FromKeptWhenSet(t *testing.T) {
	m, err := New(testMailConfig())
	if err != nil {
		t.Fatalf("New = %v", err)
	}
	defer m.Close()
	if m.from != "noreply@example.com" {
		t.Fatalf("from = %q, want %q", m.from, "noreply@example.com")
	}
}

func TestIsTransient(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"timeout", timeoutError{}, true},
		{"ioEOF", io.EOF, true},
		{"connReset", errors.New("read: connection reset by peer"), true},
		{"smtp421", errors.New("421 4.7.0 Too many connections"), true},
		{"smtp450", errors.New("450 4.2.0 Mailbox busy"), true},
		{"smtp451", errors.New("451 4.3.0 Greylisted, try again later"), true},
		{"smtp452", errors.New("452 4.2.2 Mailbox full"), true},
		{"smtp535", errors.New("535 5.7.8 Authentication credentials invalid"), false},
		{"smtp550", errors.New("550 5.1.1 Recipient address rejected"), false},
		{"smtp553", errors.New("553 5.1.2 Domain not found"), false},
		{"canceled", context.Canceled, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isTransient(tc.err); got != tc.want {
				t.Fatalf("isTransient(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}

func TestDeliver_TransientRetriedMax3WithBackoff(t *testing.T) {
	var sleeps []time.Duration
	stub := &stubSender{stubErr: errors.New("421 4.7.0 Too many connections")}
	stub.failsLeft.Store(100) // always fails
	m := newSMTPMailer("from@x", time.Second, time.Second, 10, 0, stub.send,
		func(_ context.Context, d time.Duration) error {
			sleeps = append(sleeps, d)
			return nil
		})

	m.deliver(context.Background(), mailJob{to: []string{"a@x"}, subject: "s"})

	if got := stub.calls.Load(); got != 4 {
		t.Fatalf("attempts = %d, want 4 (initial + 3 retries)", got)
	}
	want := []time.Duration{5 * time.Second, 10 * time.Second, 20 * time.Second}
	if len(sleeps) != len(want) {
		t.Fatalf("sleeps = %v, want %v", sleeps, want)
	}
	for i := range want {
		if sleeps[i] != want[i] {
			t.Fatalf("sleeps = %v, want %v", sleeps, want)
		}
	}
}

func TestDeliver_SuccessAfterRetriesStopsBackoff(t *testing.T) {
	var sleeps []time.Duration
	stub := &stubSender{stubErr: errors.New("451 4.3.0 Greylisted")}
	stub.failsLeft.Store(2)
	m := newSMTPMailer("from@x", time.Second, time.Second, 10, 0, stub.send,
		func(_ context.Context, d time.Duration) error {
			sleeps = append(sleeps, d)
			return nil
		})

	m.deliver(context.Background(), mailJob{to: []string{"a@x"}, subject: "s"})

	if got := stub.calls.Load(); got != 3 {
		t.Fatalf("attempts = %d, want 3", got)
	}
	if len(sleeps) != 2 || sleeps[0] != 5*time.Second || sleeps[1] != 10*time.Second {
		t.Fatalf("sleeps = %v, want [5s 10s]", sleeps)
	}
}

func TestDeliver_PermanentNeverRetried(t *testing.T) {
	for _, smtpErr := range []error{
		errors.New("535 5.7.8 Authentication credentials invalid"),
		errors.New("550 5.1.1 Recipient address rejected"),
	} {
		stub := &stubSender{stubErr: smtpErr}
		stub.failsLeft.Store(100)
		var sleeps int
		m := newSMTPMailer("from@x", time.Second, time.Second, 10, 0, stub.send,
			func(_ context.Context, _ time.Duration) error {
				sleeps++
				return nil
			})

		m.deliver(context.Background(), mailJob{to: []string{"a@x"}, subject: "s"})

		if got := stub.calls.Load(); got != 1 {
			t.Fatalf("attempts for %v = %d, want 1 (no retry)", smtpErr, got)
		}
		if sleeps != 0 {
			t.Fatalf("sleeps for %v = %d, want 0", smtpErr, sleeps)
		}
	}
}

func TestSend_QueueFullReturnsImmediately(t *testing.T) {
	block := make(chan struct{})
	m := newSMTPMailer("from@x", time.Second, time.Second, 1, 0,
		func(ctx context.Context, _ *mail.Msg) error {
			<-ctx.Done()
			return ctx.Err()
		},
		func(ctx context.Context, d time.Duration) error {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-block:
				return nil
			}
		})
	defer close(block)
	defer m.Close()

	// Fill the size-1 queue with no workers running: first Send occupies it.
	if err := m.Send(context.Background(), []string{"a@x"}, "s", "t", ""); err != nil {
		t.Fatalf("first Send = %v", err)
	}

	done := make(chan error, 1)
	go func() { done <- m.Send(context.Background(), []string{"b@x"}, "s", "t", "") }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("overflow Send = %v, want nil (drop, not error)", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("overflow Send blocked >2s, want immediate return")
	}
	if got := m.Dropped(); got != 1 {
		t.Fatalf("dropped = %d, want 1", got)
	}
}

func TestSend_EnqueuedJobIsDelivered(t *testing.T) {
	delivered := make(chan struct{}, 1)
	stub := &stubSender{delivered: delivered}
	m := newSMTPMailer("from@x", 5*time.Second, 5*time.Second, 10, 1, stub.send, realSleep)
	defer m.Close()

	if err := m.Send(context.Background(), []string{"a@x"}, "hello", "plain", "<b>html</b>"); err != nil {
		t.Fatalf("Send = %v", err)
	}
	select {
	case <-delivered:
	case <-time.After(5 * time.Second):
		t.Fatal("job was not delivered within 5s")
	}
}

func TestClose_DrainsQueue(t *testing.T) {
	var count atomic.Int64
	m := newSMTPMailer("from@x", 5*time.Second, 5*time.Second, 10, 2,
		func(context.Context, *mail.Msg) error { count.Add(1); return nil },
		realSleep)
	for i := 0; i < 5; i++ {
		if err := m.Send(context.Background(), []string{"a@x"}, "s", "t", ""); err != nil {
			t.Fatalf("Send %d = %v", i, err)
		}
	}
	if err := m.Close(); err != nil {
		t.Fatalf("Close = %v", err)
	}
	if got := count.Load(); got != 5 {
		t.Fatalf("delivered = %d, want 5 (drain, no loss)", got)
	}
	if err := m.Send(context.Background(), []string{"a@x"}, "s", "t", ""); err == nil {
		t.Fatal("Send after Close = nil, want error")
	}
}

func TestSend_EmptyToFailsFast(t *testing.T) {
	m, err := New(testMailConfig())
	if err != nil {
		t.Fatalf("New = %v", err)
	}
	defer m.Close()
	for _, to := range [][]string{nil, {}, {""}, {"  "}} {
		if err := m.Send(context.Background(), to, "s", "t", ""); err == nil {
			t.Fatalf("Send(%q) = nil, want validation error", to)
		}
	}
}

func TestCompose_FromNameRendersDisplayName(t *testing.T) {
	// Given: a mailer with a display name set.
	// When:  a job is composed.
	// Then:  the From header carries `"THC VMS" <addr>`; without a name it
	//        stays a bare address.
	m := newSMTPMailer("noreply@example.internal", 5*time.Second, 5*time.Second, 10, 0, nil, realSleep)
	m.fromName = "THC VMS"
	msg, err := m.compose(mailJob{to: []string{"a@x"}, subject: "s", textBody: "t"})
	if err != nil {
		t.Fatalf("compose = %v", err)
	}
	from := msg.GetFrom()
	if len(from) != 1 || from[0].Name != "THC VMS" || from[0].Address != "noreply@example.internal" {
		t.Fatalf("From = %+v, want display name THC VMS + address", from)
	}

	m.fromName = ""
	msg, err = m.compose(mailJob{to: []string{"a@x"}, subject: "s", textBody: "t"})
	if err != nil {
		t.Fatalf("compose = %v", err)
	}
	from = msg.GetFrom()
	if len(from) != 1 || from[0].Name != "" || from[0].Address != "noreply@example.internal" {
		t.Fatalf("From = %+v, want bare address when no display name", from)
	}
}
