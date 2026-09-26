package worker_test

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"thc-vms/backend/internal/worker"
)

// countingSweeper records every Run call.
type countingSweeper struct{ calls atomic.Int64 }

func (s *countingSweeper) Run(_ context.Context) worker.Summary {
	s.calls.Add(1)
	return worker.Summary{}
}

// TestWorkerRunner_StopsOnContextCancel asserts cancelling the context stops
// the ticker: Run is not called again after cancel.
func TestWorkerRunner_StopsOnContextCancel(t *testing.T) {
	sweeper := &countingSweeper{}
	runner := worker.NewRunner(sweeper, 10*time.Millisecond, nil)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		runner.Start(ctx)
	}()
	deadline := time.Now().Add(2 * time.Second)
	for sweeper.calls.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if sweeper.calls.Load() == 0 {
		cancel()
		<-done
		t.Fatal("runner never ticked before the deadline")
	}
	cancel()
	<-done
	settled := sweeper.calls.Load()
	time.Sleep(50 * time.Millisecond)
	if got := sweeper.calls.Load(); got != settled {
		t.Fatalf("Run called after cancel: %d -> %d", settled, got)
	}
}
