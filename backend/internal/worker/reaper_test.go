package worker_test

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"strings"
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/infrastructure/storage"
	"thc-vms/backend/internal/worker"
)

const (
	reaperGrace = 24 * time.Hour
	aged48h     = 48 * time.Hour
)

func reaperURL(key string) string { return reaperFakeBucketBase + key }

func aged(key string, age time.Duration) domain.ObjectInfo {
	return domain.ObjectInfo{Key: key, ModTime: workerNow.Add(-age)}
}

// newTestReaper wires a reaper to the fakes with a frozen clock and a log
// buffer the assertions read.
func newTestReaper(t *testing.T, store *fakeReaperStore, repo *fakeReaperRepo, config worker.ReaperConfig) (*worker.Reaper, *bytes.Buffer) {
	t.Helper()
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, nil))
	reaper := worker.NewReaper(worker.ReaperDeps{
		Store:  store,
		Repo:   repo,
		Config: config,
		Clock:  &stubClock{now: workerNow},
		Logger: logger,
	})
	return reaper, &logs
}

func dryRunConfig() worker.ReaperConfig {
	return worker.ReaperConfig{Grace: reaperGrace, DryRun: true}
}

func liveConfig() worker.ReaperConfig {
	return worker.ReaperConfig{Grace: reaperGrace, DryRun: false}
}

// TestReaper_DryRun_DefaultsOn_LogsWithZeroDeletes pins the headline safety
// contract: with no REAPER_DRY_RUN in the environment the pass logs every
// would-delete candidate and deletes NOTHING.
func TestReaper_DryRun_DefaultsOn_LogsWithZeroDeletes(t *testing.T) {
	t.Setenv(worker.ReaperDryRunEnv, "")
	t.Setenv(worker.ReaperGraceEnv, "")

	config := worker.ReaperConfigFromEnv()
	if !config.DryRun {
		t.Fatal("REAPER_DRY_RUN unset must default to dry-run ON")
	}
	if config.Grace != 24*time.Hour {
		t.Fatalf("REAPER_GRACE_HOURS unset = %s, want 24h", config.Grace)
	}

	key := "assignment_letters/pending/spk.pdf"
	store := newFakeReaperStore()
	store.add("assignment_letters/pending/", aged(key, aged48h))
	repo := &fakeReaperRepo{}
	reaper, logs := newTestReaper(t, store, repo, config)

	summary := reaper.Run(context.Background())

	if summary.Deleted != 0 {
		t.Fatalf("dry-run deleted = %d, want 0", summary.Deleted)
	}
	if summary.Listed != 1 || summary.Errors != 0 {
		t.Fatalf("summary = %+v, want Listed=1 Errors=0", summary)
	}
	if batches := store.batches(); len(batches) != 0 {
		t.Fatalf("dry-run called RemoveObjects: %v", batches)
	}
	if !strings.Contains(logs.String(), "reaper would delete") {
		t.Fatalf("log missing would-delete line:\n%s", logs.String())
	}
	if !strings.Contains(logs.String(), "deleted=0") {
		t.Fatalf("log missing deleted=0 summary:\n%s", logs.String())
	}
	t.Logf("dry-run sample log:\n%s", logs.String())
}

// TestReaper_LiveMode_DeletesAgedUnreferencedPendingObject proves the armed
// path: an aged, unreferenced pending/ object is batch-deleted exactly once.
func TestReaper_LiveMode_DeletesAgedUnreferencedPendingObject(t *testing.T) {
	key := "id_cards/pending/ktp.jpg"
	store := newFakeReaperStore()
	store.add("id_cards/pending/", aged(key, aged48h))
	repo := &fakeReaperRepo{}
	reaper, _ := newTestReaper(t, store, repo, liveConfig())

	summary := reaper.Run(context.Background())

	if summary.Deleted != 1 || summary.Listed != 1 || summary.Errors != 0 {
		t.Fatalf("summary = %+v, want Deleted=1 Listed=1 Errors=0", summary)
	}
	if got := store.deletedKeys(); len(got) != 1 || got[0] != key {
		t.Fatalf("deleted keys = %v, want [%s]", got, key)
	}
	if repo.acquired != 1 || repo.released != 1 {
		t.Fatalf("slot acquired=%d released=%d, want 1/1", repo.acquired, repo.released)
	}
}

// TestReaper_KeepsObjectsYoungerThanGrace: anything inside the grace window
// survives even in live mode.
func TestReaper_KeepsObjectsYoungerThanGrace(t *testing.T) {
	key := "checkin_photos/pending/selfie.jpg"
	store := newFakeReaperStore()
	store.add("checkin_photos/pending/", aged(key, time.Hour))
	repo := &fakeReaperRepo{}
	reaper, _ := newTestReaper(t, store, repo, liveConfig())

	summary := reaper.Run(context.Background())

	if summary.KeptYoung != 1 || summary.Deleted != 0 {
		t.Fatalf("summary = %+v, want KeptYoung=1 Deleted=0", summary)
	}
	if batches := store.batches(); len(batches) != 0 {
		t.Fatalf("young object was deleted: %v", batches)
	}
}

// TestReaper_KeepsObjectsZeroModTime: a listing with no trustworthy mtime is
// never treated as aged — missing evidence must not delete.
func TestReaper_KeepsObjectsZeroModTime(t *testing.T) {
	key := "profile_photos/pending/avatar.jpg"
	store := newFakeReaperStore()
	store.add("profile_photos/pending/", domain.ObjectInfo{Key: key})
	repo := &fakeReaperRepo{}
	reaper, _ := newTestReaper(t, store, repo, liveConfig())

	summary := reaper.Run(context.Background())

	if summary.KeptYoung != 1 || summary.Deleted != 0 {
		t.Fatalf("summary = %+v, want KeptYoung=1 Deleted=0", summary)
	}
}

// TestReaper_KeepsObjectsReferencedInDatabase: the anti-join protects any
// object a DB row still points at, matched through ObjectKeyFromStoredURL.
func TestReaper_KeepsObjectsReferencedInDatabase(t *testing.T) {
	key := "assignment_letters/pending/spk.pdf"
	store := newFakeReaperStore()
	store.add("assignment_letters/pending/", aged(key, aged48h))
	repo := &fakeReaperRepo{urls: []string{reaperURL(key)}}
	reaper, _ := newTestReaper(t, store, repo, liveConfig())

	summary := reaper.Run(context.Background())

	if summary.KeptReferenced != 1 || summary.Deleted != 0 {
		t.Fatalf("summary = %+v, want KeptReferenced=1 Deleted=0", summary)
	}
	if batches := store.batches(); len(batches) != 0 {
		t.Fatalf("referenced object was deleted: %v", batches)
	}
}

// TestReaper_HardGuard_NonPendingKeysNeverTouchedEvenWhenOld is the v1 hard
// rule: a lister that leaks keys outside <dir>/pending/ (final visit keys,
// pending-<userID> owner segments, foreign directories) cannot make the
// reaper count or delete them, no matter how old and unreferenced they are.
func TestReaper_HardGuard_NonPendingKeysNeverTouchedEvenWhenOld(t *testing.T) {
	inScope := "assignment_letters/pending/spk.pdf"
	outOfScope := []string{
		"assignment_letters/visit-123/spk.pdf",
		"assignment_letters/pending-user-9/spk.pdf",
		"id_cards/visitor-7/ktp.jpg",
		"checkin_photos/other/selfie.jpg",
		"profile_photos/pending-user-9/avatar.jpg",
		"random-bucket-root.txt",
	}
	store := newFakeReaperStore()
	objects := []domain.ObjectInfo{aged(inScope, aged48h)}
	for _, key := range outOfScope {
		objects = append(objects, aged(key, aged48h))
	}
	// The fake lister hands back every seeded object for EVERY prefix —
	// deliberately misbehaving, so the guard under test is the reaper's own.
	store.add("assignment_letters/pending/", objects...)
	repo := &fakeReaperRepo{}
	reaper, _ := newTestReaper(t, store, repo, liveConfig())

	summary := reaper.Run(context.Background())

	if summary.Listed != 1 {
		t.Fatalf("Listed = %d, want 1 (only the in-scope key counts)", summary.Listed)
	}
	if summary.Deleted != 1 {
		t.Fatalf("Deleted = %d, want 1", summary.Deleted)
	}
	deleted := store.deletedKeys()
	if len(deleted) != 1 || deleted[0] != inScope {
		t.Fatalf("deleted keys = %v, want only [%s]", deleted, inScope)
	}
}

// TestReaper_ListsOnlyTheFourStoragePendingPrefixes pins the scan surface to
// storage.PendingPrefixes() — the same <dir>/pending/ set the ILM runbook
// and object_key.go own — so a new category dir cannot silently escape the
// reaper and no foreign prefix can ever be requested.
func TestReaper_ListsOnlyTheFourStoragePendingPrefixes(t *testing.T) {
	store := newFakeReaperStore()
	repo := &fakeReaperRepo{}
	reaper, _ := newTestReaper(t, store, repo, liveConfig())

	reaper.Run(context.Background())

	want := storage.PendingPrefixes()
	got := store.prefixes()
	if len(got) != len(want) {
		t.Fatalf("listed prefixes = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("listed prefixes = %v, want %v", got, want)
		}
	}
}

// TestReaper_SkipsPassWhenAnotherInstanceHoldsSlot: a held slot means a clean
// no-op — nothing listed, nothing deleted, no error counted.
func TestReaper_SkipsPassWhenAnotherInstanceHoldsSlot(t *testing.T) {
	store := newFakeReaperStore()
	store.add("assignment_letters/pending/", aged("assignment_letters/pending/spk.pdf", aged48h))
	repo := &fakeReaperRepo{lockHeld: true}
	reaper, logs := newTestReaper(t, store, repo, liveConfig())

	summary := reaper.Run(context.Background())

	if summary.Listed != 0 || summary.Deleted != 0 || summary.Errors != 0 {
		t.Fatalf("summary = %+v, want all zeros", summary)
	}
	if prefixes := store.prefixes(); len(prefixes) != 0 {
		t.Fatalf("listed while slot busy: %v", prefixes)
	}
	if repo.released != 0 {
		t.Fatalf("released a slot we never acquired: %d", repo.released)
	}
	if !strings.Contains(logs.String(), "reaper slot busy") {
		t.Fatalf("log missing slot-busy line:\n%s", logs.String())
	}
}

// TestReaper_SlotAcquireError_CountsError: a lock failure is an error, not a
// silent skip, and nothing gets listed or deleted.
func TestReaper_SlotAcquireError_CountsError(t *testing.T) {
	store := newFakeReaperStore()
	repo := &fakeReaperRepo{lockErr: fmt.Errorf("pg down")}
	reaper, _ := newTestReaper(t, store, repo, liveConfig())

	summary := reaper.Run(context.Background())

	if summary.Errors != 1 || summary.Listed != 0 || summary.Deleted != 0 {
		t.Fatalf("summary = %+v, want Errors=1 and no work", summary)
	}
}

// TestReaper_ForeignReferencedURLsAreSkippedNotErrors: a DB URL that will not
// reverse to a bucket key names no object of ours, so it neither blocks the
// pass nor protects anything.
func TestReaper_ForeignReferencedURLsAreSkippedNotErrors(t *testing.T) {
	key := "id_cards/pending/ktp.jpg"
	store := newFakeReaperStore()
	store.add("id_cards/pending/", aged(key, aged48h))
	repo := &fakeReaperRepo{urls: []string{"https://evil.example.com/elsewhere/ktp.jpg"}}
	reaper, _ := newTestReaper(t, store, repo, liveConfig())

	summary := reaper.Run(context.Background())

	if summary.Errors != 0 {
		t.Fatalf("Errors = %d, want 0 (foreign URL is skipped)", summary.Errors)
	}
	if summary.Deleted != 1 {
		t.Fatalf("Deleted = %d, want 1 (foreign URL references nothing of ours)", summary.Deleted)
	}
}

// TestReaper_ListFailure_CountsErrorAndContinues: one broken prefix does not
// abort the other three.
func TestReaper_ListFailure_CountsErrorAndContinues(t *testing.T) {
	store := newFakeReaperStore()
	store.listErrs["id_cards/pending/"] = fmt.Errorf("s3 500")
	store.add("assignment_letters/pending/", aged("assignment_letters/pending/spk.pdf", aged48h))
	repo := &fakeReaperRepo{}
	reaper, _ := newTestReaper(t, store, repo, liveConfig())

	summary := reaper.Run(context.Background())

	if summary.Errors != 1 {
		t.Fatalf("Errors = %d, want 1", summary.Errors)
	}
	if summary.Deleted != 1 {
		t.Fatalf("Deleted = %d, want 1 (other prefixes still reaped)", summary.Deleted)
	}
}

// TestReaper_ReferencedListingFailure_FailsClosed: without the anti-join
// snapshot NOTHING may be deleted — a broken DB read can never wipe live
// objects.
func TestReaper_ReferencedListingFailure_FailsClosed(t *testing.T) {
	store := newFakeReaperStore()
	store.add("assignment_letters/pending/", aged("assignment_letters/pending/spk.pdf", aged48h))
	repo := &fakeReaperRepo{listErr: fmt.Errorf("db down")}
	reaper, _ := newTestReaper(t, store, repo, liveConfig())

	summary := reaper.Run(context.Background())

	if summary.Errors != 1 {
		t.Fatalf("Errors = %d, want 1", summary.Errors)
	}
	if batches := store.batches(); len(batches) != 0 {
		t.Fatalf("deleted without anti-join: %v", batches)
	}
}

// TestReaper_BatchesDeletesAt1000KeysPerCall: candidates beyond one S3
// multi-object-delete request are chunked, never handed over in one lump.
func TestReaper_BatchesDeletesAt1000KeysPerCall(t *testing.T) {
	const total = 1001
	prefix := "checkin_photos/pending/"
	var objects []domain.ObjectInfo
	for i := 0; i < total; i++ {
		objects = append(objects, aged(fmt.Sprintf("%sspam-%04d.jpg", prefix, i), aged48h))
	}
	store := newFakeReaperStore()
	store.add(prefix, objects...)
	repo := &fakeReaperRepo{}
	reaper, _ := newTestReaper(t, store, repo, liveConfig())

	summary := reaper.Run(context.Background())

	if summary.Deleted != total {
		t.Fatalf("Deleted = %d, want %d", summary.Deleted, total)
	}
	batches := store.batches()
	if len(batches) != 2 {
		t.Fatalf("RemoveObjects calls = %d, want 2 (1000 + 1)", len(batches))
	}
	if len(batches[0]) != 1000 || len(batches[1]) != 1 {
		t.Fatalf("batch sizes = %d,%d, want 1000,1", len(batches[0]), len(batches[1]))
	}
}

// TestReaper_RemoveError_CountsErrorAndNotDeleted: a failed batch is an
// error and never counted as deleted.
func TestReaper_RemoveError_CountsErrorAndNotDeleted(t *testing.T) {
	store := newFakeReaperStore()
	store.add("profile_photos/pending/", aged("profile_photos/pending/avatar.jpg", aged48h))
	store.removeErr = fmt.Errorf("s3 unreachable")
	repo := &fakeReaperRepo{}
	reaper, _ := newTestReaper(t, store, repo, liveConfig())

	summary := reaper.Run(context.Background())

	if summary.Errors != 1 || summary.Deleted != 0 {
		t.Fatalf("summary = %+v, want Errors=1 Deleted=0", summary)
	}
}

// TestReaper_MissingDependencies_CountError: an unwired reaper aborts loudly
// instead of panicking.
func TestReaper_MissingDependencies_CountError(t *testing.T) {
	reaper := worker.NewReaper(worker.ReaperDeps{Config: liveConfig()})

	summary := reaper.Run(context.Background())

	if summary.Errors != 1 {
		t.Fatalf("Errors = %d, want 1", summary.Errors)
	}
}

// TestReaper_New_AppliesSafeDefaults: zero Grace must never mean "delete
// everything now"; zero Interval means nightly; nil clock/logger fall back.
func TestReaper_New_AppliesSafeDefaults(t *testing.T) {
	reaper := worker.NewReaper(worker.ReaperDeps{})
	if reaper.Interval() != 24*time.Hour {
		t.Fatalf("Interval = %s, want 24h", reaper.Interval())
	}
	summary := reaper.Run(context.Background())
	if summary.Errors != 1 {
		t.Fatalf("Errors = %d, want 1 (nil ports abort)", summary.Errors)
	}

	reaper = worker.NewReaper(worker.ReaperDeps{
		Store:    newFakeReaperStore(),
		Repo:     &fakeReaperRepo{},
		Config:   worker.ReaperConfig{Grace: 0, DryRun: true},
		Interval: 0,
	})
	summary = reaper.Run(context.Background())
	if summary.Errors != 0 {
		t.Fatalf("Errors = %d, want 0", summary.Errors)
	}
}

// TestReaperConfigFromEnv_FailsSafe: every hostile or absent value lands on
// the safe default — dry-run ON, grace 24h.
func TestReaperConfigFromEnv_FailsSafe(t *testing.T) {
	tests := []struct {
		name      string
		dryRun    string
		grace     string
		wantDry   bool
		wantGrace time.Duration
	}{
		{"absent", "", "", true, 24 * time.Hour},
		{"explicit on", "1", "48", true, 48 * time.Hour},
		{"explicit off numeric", "0", "1", false, time.Hour},
		{"explicit off word", "false", "7", false, 7 * time.Hour},
		{"unrecognised dry-run stays on", "banana", "", true, 24 * time.Hour},
		{"zero grace falls back", "", "0", true, 24 * time.Hour},
		{"negative grace falls back", "", "-3", true, 24 * time.Hour},
		{"garbage grace falls back", "", "abc", true, 24 * time.Hour},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv(worker.ReaperDryRunEnv, tt.dryRun)
			t.Setenv(worker.ReaperGraceEnv, tt.grace)
			config := worker.ReaperConfigFromEnv()
			if config.DryRun != tt.wantDry {
				t.Fatalf("DryRun = %v, want %v", config.DryRun, tt.wantDry)
			}
			if config.Grace != tt.wantGrace {
				t.Fatalf("Grace = %s, want %s", config.Grace, tt.wantGrace)
			}
		})
	}
}

// TestReaperIntervalFromEnv_FailsSafe: absent or malformed REAPER_INTERVAL
// means nightly, never a stall and never a hot loop.
func TestReaperIntervalFromEnv_FailsSafe(t *testing.T) {
	tests := []struct {
		raw  string
		want time.Duration
	}{
		{"", 24 * time.Hour},
		{"6h", 6 * time.Hour},
		{"garbage", 24 * time.Hour},
		{"-5m", 24 * time.Hour},
	}
	for _, tt := range tests {
		t.Run(tt.raw, func(t *testing.T) {
			t.Setenv(worker.ReaperIntervalEnv, tt.raw)
			if got := worker.ReaperIntervalFromEnv(); got != tt.want {
				t.Fatalf("IntervalFromEnv(%q) = %s, want %s", tt.raw, got, tt.want)
			}
		})
	}
}

// TestReaper_Start_RepeatsUntilContextCancel mirrors the auto-rule runner
// contract: immediate first pass, then ticker passes, clean stop on cancel.
func TestReaper_Start_RepeatsUntilContextCancel(t *testing.T) {
	store := newFakeReaperStore()
	repo := &fakeReaperRepo{}
	reaper := worker.NewReaper(worker.ReaperDeps{
		Store:    store,
		Repo:     repo,
		Config:   dryRunConfig(),
		Interval: 10 * time.Millisecond,
		Clock:    &stubClock{now: workerNow},
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		reaper.Start(ctx)
	}()
	deadline := time.Now().Add(2 * time.Second)
	for len(store.prefixes()) < 8 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if len(store.prefixes()) < 8 {
		cancel()
		<-done
		t.Fatalf("reaper never repeated: %d prefixes listed", len(store.prefixes()))
	}
	cancel()
	<-done
	settled := len(store.prefixes())
	time.Sleep(50 * time.Millisecond)
	if got := len(store.prefixes()); got != settled {
		t.Fatalf("reaper kept running after cancel: %d -> %d", settled, got)
	}
}
