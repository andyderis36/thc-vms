package mailer

import (
	"context"
	"testing"
	"time"
)

// TestQueueDepth_ReflectsBacklog membuktikan QueueDepth melaporkan antrean
// yang menunggu tanpa mengubah perilaku kirim: dua Send antre dua pekerjaan,
// Send ketiga saat penuh menambah Dropped tanpa memblokir.
func TestQueueDepth_ReflectsBacklog(t *testing.T) {
	m := newSMTPMailer("from@x", time.Second, time.Second, 2, 0, nil, nil)
	defer func() {
		_ = m.Close()
	}()
	ctx := context.Background()
	if err := m.Send(ctx, []string{"a@x"}, "s1", "b1", ""); err != nil {
		t.Fatalf("Send 1: %v", err)
	}
	if err := m.Send(ctx, []string{"b@x"}, "s2", "b2", ""); err != nil {
		t.Fatalf("Send 2: %v", err)
	}
	if got := m.QueueDepth(); got != 2 {
		t.Fatalf("QueueDepth() = %d, want 2", got)
	}
	if err := m.Send(ctx, []string{"c@x"}, "s3", "b3", ""); err != nil {
		t.Fatalf("Send 3 (penuh): %v", err)
	}
	if got := m.QueueDepth(); got != 2 {
		t.Fatalf("QueueDepth() sesudah drop = %d, want tetap 2", got)
	}
	if got := m.Dropped(); got != 1 {
		t.Fatalf("Dropped() = %d, want 1", got)
	}
}
