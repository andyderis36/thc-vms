package mailer

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
)

// fakeMailLogWriter records every verdict write in memory and signals each
// arrival on buffered channels, so tests await the exact event with a bounded
// timeout instead of sleeping. An injected err makes every write fail, which
// must never fail a send (best-effort contract).
type fakeMailLogWriter struct {
	mu        sync.Mutex
	queued    []domain.MailLog
	verdicts  []domain.MailLog
	queuedCh  chan struct{}
	verdictCh chan struct{}
	err       error
}

func newFakeMailLogWriter() *fakeMailLogWriter {
	return &fakeMailLogWriter{queuedCh: make(chan struct{}, 16), verdictCh: make(chan struct{}, 16)}
}

func (f *fakeMailLogWriter) InsertQueued(_ context.Context, entry domain.MailLog) error {
	if f.err != nil {
		return f.err
	}
	f.mu.Lock()
	f.queued = append(f.queued, entry)
	f.mu.Unlock()
	select {
	case f.queuedCh <- struct{}{}:
	default:
	}
	return nil
}

func (f *fakeMailLogWriter) RecordVerdict(_ context.Context, verdict domain.MailLog) error {
	if f.err != nil {
		return f.err
	}
	f.mu.Lock()
	f.verdicts = append(f.verdicts, verdict)
	f.mu.Unlock()
	select {
	case f.verdictCh <- struct{}{}:
	default:
	}
	return nil
}

func (f *fakeMailLogWriter) lastVerdict() domain.MailLog {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.verdicts[len(f.verdicts)-1]
}

func (f *fakeMailLogWriter) verdictCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.verdicts)
}

// awaitMailLog blocks until the channel delivers or the bound lapses.
func awaitMailLog(t *testing.T, ch <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for mail_log %s", what)
	}
}

// TestMailLog_QueuedThenSent membuktikan transisi queued→sent tercatat:
// baris queued membawa penerima+templat, verdict sent membawa attempts=1
// tanpa error.
func TestMailLog_QueuedThenSent(t *testing.T) {
	stub := &stubSender{}
	logs := newFakeMailLogWriter()
	m := newSMTPMailer("from@x", time.Second, time.Second, 10, 1, stub.send, realSleep).WithMailLog(logs)
	defer m.Close()

	if err := m.SendTemplated(context.Background(), "visit_approved", []string{"a@x"}, "s", "teks", "<p>h</p>"); err != nil {
		t.Fatalf("SendTemplated = %v", err)
	}
	awaitMailLog(t, logs.queuedCh, "queued insert")
	awaitMailLog(t, logs.verdictCh, "sent verdict")

	if len(logs.queued) != 1 {
		t.Fatalf("queued rows = %d, want 1", len(logs.queued))
	}
	q := logs.queued[0]
	if len(q.Recipients) != 1 || q.Recipients[0] != "a@x" {
		t.Fatalf("queued to = %v, want [a@x]", q.Recipients)
	}
	if q.Template != "visit_approved" || q.Status != domain.MailLogQueued {
		t.Fatalf("queued = template %q status %q, want visit_approved/queued", q.Template, q.Status)
	}
	v := logs.lastVerdict()
	if v.Status != domain.MailLogSent || v.Attempts != 1 || v.Error != nil {
		t.Fatalf("verdict = %+v, want sent attempts 1 tanpa error", v)
	}
	if v.ID != q.ID {
		t.Fatalf("verdict id %q tidak berkorelasi dengan queued id %q", v.ID, q.ID)
	}
	if stub.calls.Load() != 1 {
		t.Fatalf("send attempts = %d, want 1", stub.calls.Load())
	}
}

// TestMailLog_RateLimitFailedKeeps451 membuktikan verdict failed setelah
// retry habis: attempts = 1 awal + 3 retry, dan teks error 451 tersimpan di
// kolom error.
func TestMailLog_RateLimitFailedKeeps451(t *testing.T) {
	stub := &stubSender{stubErr: errors.New("451 4.3.0 Greylisted, try again later")}
	stub.failsLeft.Store(100)
	logs := newFakeMailLogWriter()
	m := newSMTPMailer("from@x", time.Second, time.Second, 10, 1, stub.send,
		func(context.Context, time.Duration) error { return nil }).WithMailLog(logs)
	defer m.Close()

	if err := m.Send(context.Background(), []string{"a@x"}, "s", "t", ""); err != nil {
		t.Fatalf("Send = %v", err)
	}
	awaitMailLog(t, logs.verdictCh, "failed verdict")

	v := logs.lastVerdict()
	if v.Status != domain.MailLogFailed {
		t.Fatalf("status = %q, want failed", v.Status)
	}
	if v.Attempts != 4 {
		t.Fatalf("attempts = %d, want 4 (1 awal + 3 retry)", v.Attempts)
	}
	if v.Error == nil || *v.Error == "" || !contains451(*v.Error) {
		t.Fatalf("error = %v, want teks 451 tersimpan", v.Error)
	}
	if got := stub.calls.Load(); got != 4 {
		t.Fatalf("send attempts = %d, want 4", got)
	}
}

func contains451(s string) bool {
	for i := 0; i+3 <= len(s); i++ {
		if s[i:i+3] == "451" {
			return true
		}
	}
	return false
}

// TestMailLog_BestEffortWriterError membuktikan kegagalan tulis log tak
// pernah menggagalkan kirim: Send tetap antre dan flush tetap jalan.
func TestMailLog_BestEffortWriterError(t *testing.T) {
	stub := &stubSender{delivered: make(chan struct{}, 1)}
	logs := newFakeMailLogWriter()
	logs.err = errors.New("db down")
	m := newSMTPMailer("from@x", 5*time.Second, 5*time.Second, 10, 1, stub.send, realSleep).WithMailLog(logs)
	defer m.Close()

	if err := m.Send(context.Background(), []string{"a@x"}, "s", "t", ""); err != nil {
		t.Fatalf("Send = %v, want nil walau writer gagal", err)
	}
	select {
	case <-stub.delivered:
	case <-time.After(5 * time.Second):
		t.Fatal("job tidak ter-flush walau writer gagal")
	}
}

// TestMailLog_EnqueueNeverWaitsOnLog membuktikan hot path tak menunggu
// database: Send kembali walau tulis queued diblokir, dan job tetap antre.
func TestMailLog_EnqueueNeverWaitsOnLog(t *testing.T) {
	release := make(chan struct{})
	blocking := &blockingWriter{release: release}
	m := newSMTPMailer("from@x", time.Second, time.Second, 10, 0, nil, realSleep).WithMailLog(blocking)
	defer m.Close()

	done := make(chan error, 1)
	go func() { done <- m.Send(context.Background(), []string{"a@x"}, "s", "t", "") }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Send = %v, want nil", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Send terblokir oleh tulis log (>3s), want kembali segera")
	}
	if got := m.QueueDepth(); got != 1 {
		t.Fatalf("queue depth = %d, want 1 (job antre walau log tertunda)", got)
	}
	close(release)
}

// blockingWriter menahan InsertQueued sampai release ditutup.
type blockingWriter struct {
	release chan struct{}
}

func (b *blockingWriter) InsertQueued(ctx context.Context, _ domain.MailLog) error {
	select {
	case <-b.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (b *blockingWriter) RecordVerdict(context.Context, domain.MailLog) error { return nil }

// TestMailLog_ComposeFailureVerdict membuktikan verdict failed attempts=0
// saat pesan tak bisa dibangun (tanpa percobaan kirim).
func TestMailLog_ComposeFailureVerdict(t *testing.T) {
	logs := newFakeMailLogWriter()
	m := newSMTPMailer("not-an-email", time.Second, time.Second, 10, 0, nil, realSleep).WithMailLog(logs)

	m.deliver(context.Background(), mailJob{id: "job-compose", to: []string{"a@x"}, subject: "s"})

	if logs.verdictCount() != 1 {
		t.Fatalf("verdicts = %d, want 1", logs.verdictCount())
	}
	v := logs.lastVerdict()
	if v.Status != domain.MailLogFailed || v.Attempts != 0 || v.Error == nil {
		t.Fatalf("verdict = %+v, want failed attempts 0 dengan error", v)
	}
}

// TestMailLog_DryRunSkipsLogging membuktikan dry-run tak menulis baris apa
// pun: tak ada dial, tak ada jejak phantom.
func TestMailLog_DryRunSkipsLogging(t *testing.T) {
	logs := newFakeMailLogWriter()
	m := newSMTPMailer("from@x", time.Second, time.Second, 10, 0, nil, realSleep).WithMailLog(logs)
	m.dryRun = true

	m.deliver(context.Background(), mailJob{id: "job-dry", to: []string{"a@x"}, subject: "s"})

	if logs.verdictCount() != 0 || len(logs.queued) != 0 {
		t.Fatalf("dry-run menulis log: queued %d verdicts %d, want 0/0", len(logs.queued), logs.verdictCount())
	}
}

// TestMailLog_SleepAbortedVerdict membuktikan verdict failed tetap tercatat
// saat backoff dibatalkan (attempts = percobaan yang sudah jalan).
func TestMailLog_SleepAbortedVerdict(t *testing.T) {
	stub := &stubSender{stubErr: errors.New("421 4.7.0 Too many connections")}
	stub.failsLeft.Store(100)
	logs := newFakeMailLogWriter()
	m := newSMTPMailer("from@x", time.Second, time.Second, 10, 0, stub.send,
		func(context.Context, time.Duration) error { return context.Canceled }).WithMailLog(logs)

	m.deliver(context.Background(), mailJob{id: "job-abort", to: []string{"a@x"}, subject: "s"})

	if logs.verdictCount() != 1 {
		t.Fatalf("verdicts = %d, want 1", logs.verdictCount())
	}
	v := logs.lastVerdict()
	if v.Status != domain.MailLogFailed || v.Attempts != 1 {
		t.Fatalf("verdict = %+v, want failed attempts 1", v)
	}
}
