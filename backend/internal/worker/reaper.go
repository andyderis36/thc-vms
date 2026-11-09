package worker

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"thc-vms/backend/internal/domain"
)

// reaperBatchLimit is the S3 multi-object-delete request cap: the reaper
// hands RemoveObjects at most this many keys per call so no single call can
// exceed what one DeleteObjects API request accepts, whatever the SDK does
// internally.
const reaperBatchLimit = 1000

// pendingPrefixes are the ONLY five prefixes this job ever lists. They are
// fixed here rather than caller-supplied so no wiring mistake can widen the
// scan: each is "<category dir>/pending/" with the trailing slash, exactly
// the shape the ILM runbook (docs/5. LOCAL_DEV.md §9) mandates and exactly
// what storage.categoryDirectories (object_key.go) maps the five upload
// categories onto (asserted against storage.PendingPrefixes in the tests).
// Keys under any other owner segment — pending-<userID>, visit ids, visitor
// ids — are out of scope for v1 and are never listed nor deleted; the check
// is repeated per object in inPendingScope, so even a lister that returns
// foreign keys cannot widen the reaper.
var pendingPrefixes = []string{
	"assignment_letters/pending/",
	"id_cards/pending/",
	"checkin_photos/pending/",
	"profile_photos/pending/",
	"work_photos/pending/",
}

// ReaperStore is the object-storage seam the reaper needs: the Wave-1 key
// reversal for the anti-join, a prefix listing, and a batch delete. It is
// consumer-defined (the CheckInBatchProber pattern) so domain.IStorageService
// keeps its Wave-1 surface and every existing fake in other packages keeps
// compiling; *storage.MinIOAdapter satisfies it structurally, so the worker
// still never talks to MinIO directly.
type ReaperStore interface {
	// ObjectKeyFromStoredURL is the domain.IStorageService method of the
	// same name: the anti-join matches DB URLs to listed keys through it.
	ObjectKeyFromStoredURL(rawURL string) (string, error)
	// ListObjects returns every object under prefix (recursive). An
	// implementation refuses an empty prefix; the reaper only ever passes
	// one of pendingPrefixes.
	ListObjects(ctx context.Context, prefix string) ([]domain.ObjectInfo, error)
	// RemoveObjects deletes keys in one batched call. The reaper chunks at
	// reaperBatchLimit keys per call.
	RemoveObjects(ctx context.Context, keys []string) error
}

// ReaperRepository is the database seam: the anti-join inventory plus the
// single-instance slot. The production adapter (repository.NewReaperRepository,
// wired in cmd/server/main.go — the assignment there is the compile-time
// proof) implements both on the shared pgxpool; the slot is a session-scoped
// Postgres advisory lock, the same mechanism migrate.Up uses, so server
// replicas never reap concurrently.
type ReaperRepository interface {
	// ListReferencedURLs returns every stored file URL the schema can point
	// at: visit_request.assignment_letter_url, visitor.id_card_photo_url,
	// visitor.photo_url, check_in.photo_url, users.avatar_url and
	// visit_work_photo.url (NULLs and empty strings excluded).
	ListReferencedURLs(ctx context.Context) ([]string, error)
	// TryLock takes the single-instance slot. ok=false means another replica
	// holds it right now and the caller must skip the pass; release unlocks
	// the slot and must be called exactly once (defer it immediately).
	TryLock(ctx context.Context) (release func() error, ok bool, err error)
}

// ReaperSummary counts one pass: how many in-scope objects were listed and
// what became of them. DryRun is mirrored in so a caller (and the log line)
// can tell a log-only pass from a live one.
type ReaperSummary struct {
	Listed         int
	KeptYoung      int
	KeptReferenced int
	Deleted        int
	Errors         int
	DryRun         bool
}

// ReaperDeps wires one reaper. Store and Repo are mandatory; a nil one makes
// every pass abort with Errors=1 instead of panicking. Config's zero value
// is dangerous (DryRun=false is live), so construct it with
// ReaperConfigFromEnv or set DryRun explicitly. Interval ≤0 falls back to
// DefaultReaperInterval (nightly); a nil Clock becomes the wall clock and a
// nil Logger slog.Default.
type ReaperDeps struct {
	Store    ReaperStore
	Repo     ReaperRepository
	Config   ReaperConfig
	Interval time.Duration
	Clock    domain.Clock
	Logger   *slog.Logger
}

// Reaper is the nightly pending/-only orphan reaper: it lists the five
// staging prefixes, drops objects younger than the grace window or still
// referenced by a DB row, and batch-deletes the rest — or, in dry-run, only
// logs them. Precision tool per the runbook: the 7-day ILM rule stays the
// backstop.
type Reaper struct {
	store    ReaperStore
	repo     ReaperRepository
	config   ReaperConfig
	interval time.Duration
	clock    domain.Clock
	logger   *slog.Logger
}

// NewReaper builds the job from its deps, applying the documented fallbacks:
// a non-positive Grace becomes DefaultReaperGrace (never zero — zero grace
// would delete every unreferenced pending object on the first tick), a
// non-positive Interval becomes DefaultReaperInterval, a nil Clock the wall
// clock, a nil Logger slog.Default.
func NewReaper(deps ReaperDeps) *Reaper {
	clock := deps.Clock
	if clock == nil {
		clock = domain.SystemClock{}
	}
	logger := deps.Logger
	if logger == nil {
		logger = slog.Default()
	}
	config := deps.Config
	if config.Grace <= 0 {
		config.Grace = DefaultReaperGrace
	}
	interval := deps.Interval
	if interval <= 0 {
		interval = DefaultReaperInterval
	}
	return &Reaper{
		store:    deps.Store,
		repo:     deps.Repo,
		config:   config,
		interval: interval,
		clock:    clock,
		logger:   logger,
	}
}

// Interval reports the configured tick period.
func (r *Reaper) Interval() time.Duration {
	return r.interval
}

// Run executes ONE reaper pass and returns its counters. It never panics and
// never deletes anything that is not simultaneously (a) under one of the
// five pendingPrefixes, (b) at least Grace old and (c) absent from the
// DB-referenced set. Pass order is inventory → anti-join → classify →
// delete: the referenced snapshot is taken as close to the delete as the
// listing allows, so the window in which a row could start referencing an
// already-listed object is bounded by the classify step — and any such
// object would have to be Grace old before it could be a candidate at all.
func (r *Reaper) Run(ctx context.Context) ReaperSummary {
	summary := ReaperSummary{DryRun: r.config.DryRun}
	if r.store == nil || r.repo == nil {
		summary.Errors++
		r.logger.Error("reaper pass aborted: missing dependencies")
		return summary
	}
	release, ok, err := r.repo.TryLock(ctx)
	if err != nil {
		summary.Errors++
		r.logger.Error("reaper slot acquire failed", "err", err)
		return summary
	}
	if !ok {
		// Another replica is mid-pass. Skipping is normal operation, not
		// an error, and it is the whole point of the slot.
		r.logger.Info("reaper slot busy: another instance is running, skipping pass")
		return summary
	}
	defer func() {
		if err := release(); err != nil {
			r.logger.Error("reaper slot release failed", "err", err)
		}
	}()
	r.reap(ctx, &summary)
	r.logger.Info("reaper pass finished",
		"listed", summary.Listed,
		"kept-young", summary.KeptYoung,
		"kept-referenced", summary.KeptReferenced,
		"deleted", summary.Deleted,
		"errors", summary.Errors,
		"dry_run", summary.DryRun)
	return summary
}

// Start runs one pass immediately and then on every interval tick until ctx
// is cancelled, mirroring Runner.Start: the same immediate-first-tick shape,
// the same ticker, the same clean stop. It blocks; the caller runs it in its
// own goroutine.
func (r *Reaper) Start(ctx context.Context) {
	r.Run(ctx)
	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			r.logger.Info("pending-orphan reaper stopped")
			return
		case <-ticker.C:
			r.Run(ctx)
		}
	}
}

// reap is the pass body: inventory the five prefixes, snapshot the
// referenced set, classify, then delete (or, in dry-run, only log) the
// remainder.
func (r *Reaper) reap(ctx context.Context, summary *ReaperSummary) {
	type listedObject struct {
		key     string
		modTime time.Time
	}

	var listed []listedObject
	for _, prefix := range pendingPrefixes {
		objects, err := r.store.ListObjects(ctx, prefix)
		if err != nil {
			// One failing prefix does not abort the others; its objects
			// simply cannot be considered this pass.
			summary.Errors++
			r.logger.Error("reaper list failed", "prefix", prefix, "err", err)
			continue
		}
		for _, obj := range objects {
			if !strings.HasPrefix(obj.Key, prefix) {
				// HARD GUARD (v1): a key outside pending/ is never
				// counted, classified or deleted, even when old and
				// unreferenced.
				r.logger.Warn("reaper ignored out-of-scope key", "key", obj.Key, "prefix", prefix)
				continue
			}
			summary.Listed++
			listed = append(listed, listedObject{key: obj.Key, modTime: obj.ModTime})
		}
	}

	// Fail closed: without the referenced set NOTHING may be deleted, so a
	// broken anti-join can never wipe live objects.
	urls, err := r.repo.ListReferencedURLs(ctx)
	if err != nil {
		summary.Errors++
		r.logger.Error("reaper referenced listing failed, skipping delete", "err", err)
		return
	}
	referenced := make(map[string]struct{}, len(urls))
	for _, raw := range urls {
		key, err := r.store.ObjectKeyFromStoredURL(raw)
		if err != nil {
			// By the port contract a URL that will not reverse names no
			// object in OUR bucket (foreign host, API path, traversal), so
			// it cannot keep a pending/ object alive. Skip, not an error.
			continue
		}
		referenced[key] = struct{}{}
	}

	cutoff := r.clock.Now().Add(-r.config.Grace)
	var candidates []string
	for _, obj := range listed {
		if obj.modTime.IsZero() || obj.modTime.After(cutoff) {
			// Younger than grace — or carrying no trustworthy mtime:
			// never delete on missing evidence.
			summary.KeptYoung++
			continue
		}
		if _, ok := referenced[obj.key]; ok {
			summary.KeptReferenced++
			continue
		}
		candidates = append(candidates, obj.key)
	}

	if r.config.DryRun {
		for _, key := range candidates {
			r.logger.Info("reaper would delete", "key", key)
		}
		return // Deleted stays 0: log-only is the entire point of dry-run.
	}
	for start := 0; start < len(candidates); start += reaperBatchLimit {
		batch := candidates[start:min(start+reaperBatchLimit, len(candidates))]
		if err := r.store.RemoveObjects(ctx, batch); err != nil {
			summary.Errors++
			r.logger.Error("reaper batch delete failed", "batch", len(batch), "err", err)
			continue
		}
		summary.Deleted += len(batch)
	}
}
