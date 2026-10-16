package repository

// TDD (S4 resource bound + S1 N+1 kill): the three auto-rule sweeps must be
// row-capped, and hydrate() must load a sweep with ONE batched round trip,
// never FindByID-per-id.

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"thc-vms/backend/internal/domain"
)

// TestSweepQueries_AreCappedAt500 proves every sweep in worker.sql carries a
// LIMIT 500 while keeping its FOR UPDATE ... SKIP LOCKED semantics, so one
// tick can never lock (or migrate) the whole table.
func TestSweepQueries_AreCappedAt500(t *testing.T) {
	t.Parallel()
	// Given: the shipped sweep SQL.
	raw, err := os.ReadFile("db/queries/worker.sql")
	if err != nil {
		t.Fatalf("read worker.sql: %v", err)
	}
	// When/Then: each sweep block is capped and still skips locked rows.
	for _, name := range []string{
		"SweepStaleRequestedVisits",
		"SweepNoShowApprovedVisits",
		"SweepStaleVisitingVisits",
	} {
		block := sweepBlock(t, string(raw), name)
		upper := strings.ToUpper(block)
		if !strings.Contains(upper, "LIMIT 500") {
			t.Errorf("%s has no LIMIT 500 cap (RED: unbounded sweep)", name)
		}
		if !strings.Contains(upper, "SKIP LOCKED") {
			t.Errorf("%s lost SKIP LOCKED (must keep concurrent-worker semantics)", name)
		}
	}
}

// sweepBlock extracts the "-- name: <name>" section from a sqlc query file.
func sweepBlock(t *testing.T, raw, name string) string {
	t.Helper()
	start := strings.Index(raw, "-- name: "+name)
	if start < 0 {
		t.Fatalf("query %s not found in worker.sql", name)
	}
	rest := raw[start+len("-- name: "+name):]
	if next := strings.Index(rest, "-- name: "); next >= 0 {
		return rest[:next]
	}
	return rest
}

// TestHydrate_IssuesOneBatchQuery proves hydrate() loads N swept ids with
// exactly ONE batch load — not N FindByID round trips — while keeping sweep
// order and the status/horizon filter.
func TestHydrate_IssuesOneBatchQuery(t *testing.T) {
	t.Parallel()
	// Given: 5 swept ids, all still requested; one extra row already approved.
	now := time.Now().UTC().Truncate(time.Second)
	ids := make([]uuid.UUID, 0, 6)
	canned := make([]domain.VisitRequest, 0, 6)
	for i := 0; i < 5; i++ {
		id := uuid.New()
		ids = append(ids, id)
		canned = append(canned, domain.VisitRequest{
			ID:        toDomainUUID(id),
			Status:    domain.VisitStatusRequested,
			CreatedAt: now.Add(-8 * 24 * time.Hour),
			StartDate: now.Add(-8 * 24 * time.Hour),
			EndDate:   now.Add(-8*24*time.Hour + 4*time.Hour),
		})
	}
	approvedID := uuid.New()
	ids = append(ids, approvedID)
	canned = append(canned, domain.VisitRequest{
		ID:        toDomainUUID(approvedID),
		Status:    domain.VisitStatusApproved,
		CreatedAt: now.Add(-8 * 24 * time.Hour),
		StartDate: now.Add(-8 * 24 * time.Hour),
		EndDate:   now.Add(-8*24*time.Hour + 4*time.Hour),
	})
	calls := 0
	var seen []uuid.UUID
	repo := &visitAutoRuleRepository{
		batchLoad: func(_ context.Context, batch []uuid.UUID) ([]domain.VisitRequest, error) {
			calls++
			seen = append([]uuid.UUID(nil), batch...)
			return canned, nil
		},
	}
	// When: the sweep hydrates its 6 ids.
	got, err := repo.hydrate(context.Background(), ids, domain.VisitStatusRequested,
		func(domain.VisitRequest) bool { return true })
	// Then: exactly one batch load carried all 6 ids ...
	if err != nil {
		t.Fatalf("hydrate: %v", err)
	}
	if calls != 1 {
		t.Fatalf("hydrate issued %d batch loads for 6 ids, want exactly 1 (RED: N+1)", calls)
	}
	if len(seen) != len(ids) {
		t.Fatalf("batch load carried %d ids, want %d", len(seen), len(ids))
	}
	// ... and only the 5 still-requested visits survive, in sweep order.
	if len(got) != 5 {
		t.Fatalf("hydrate kept %d visits, want 5 (status filter broke)", len(got))
	}
	for i := range got {
		if got[i].ID != toDomainUUID(ids[i]) {
			t.Fatalf("hydrate order drifted at %d: got %s, want %s", i, got[i].ID, toDomainUUID(ids[i]))
		}
	}
}

// TestHydrate_EmptySweepIssuesNoQuery proves an empty sweep short-circuits
// before touching the database at all.
func TestHydrate_EmptySweepIssuesNoQuery(t *testing.T) {
	t.Parallel()
	calls := 0
	repo := &visitAutoRuleRepository{
		batchLoad: func(_ context.Context, _ []uuid.UUID) ([]domain.VisitRequest, error) {
			calls++
			return nil, nil
		},
	}
	got, err := repo.hydrate(context.Background(), nil, domain.VisitStatusRequested,
		func(domain.VisitRequest) bool { return true })
	if err != nil {
		t.Fatalf("hydrate: %v", err)
	}
	if calls != 0 {
		t.Fatalf("empty sweep issued %d queries, want 0", calls)
	}
	if got == nil || len(got) != 0 {
		t.Fatalf("empty sweep returned %v, want empty non-nil slice", got)
	}
}
