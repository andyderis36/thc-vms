package mailer

import (
	"context"
	"testing"
	"time"

	"thc-vms/backend/internal/config"
)

// TestDryRun_SkipsDialAgainstUnroutableHost proves the CI no-network mode:
// with DryRun armed the mailer drains the queue and closes cleanly without
// ever dialing, even at an unroutable TEST-NET-1 address.
func TestDryRun_SkipsDialAgainstUnroutableHost(t *testing.T) {
	cfg := &config.Config{
		Mail: config.Mail{
			Enabled:  true,
			Host:     "192.0.2.1",
			Port:     1025,
			From:     "noreply@example.com",
			Timeout:  2 * time.Second,
			DryRun:   true,
		},
	}
	m, err := New(cfg)
	if err != nil {
		t.Fatalf("New = %v", err)
	}

	done := make(chan error, 1)
	go func() {
		if err := m.Send(context.Background(), []string{"ci@example.com"}, "dry-run subject", "plain", ""); err != nil {
			done <- err
			return
		}
		done <- m.Close()
	}()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Send+Close in dry-run = %v, want clean drain with no dial", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("dry-run drain blocked >10s, want immediate log-only return (a dial was attempted)")
	}
}

// TestNew_DryRunPropagatesFromConfig proves the constructor carries the
// config gate onto the adapter; Send-time behavior needs no further wiring.
func TestNew_DryRunPropagatesFromConfig(t *testing.T) {
	for _, dryRun := range []bool{true, false} {
		cfg := &config.Config{
			Mail: config.Mail{
				Enabled: true,
				Host:    "localhost",
				Port:    1025,
				From:    "noreply@example.com",
				DryRun:  dryRun,
			},
		}
		m, err := New(cfg)
		if err != nil {
			t.Fatalf("New(dryRun=%v) = %v", dryRun, err)
		}
		if m.dryRun != dryRun {
			t.Errorf("dryRun = %v, want %v", m.dryRun, dryRun)
		}
		if err := m.Close(); err != nil {
			t.Fatalf("Close() = %v", err)
		}
	}
}
