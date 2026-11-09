package repository

import (
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
)

// TestReaperRepository_ListReferencedURLs_IncludesVisitWorkPhotos is the
// anti-join proof for migration 000024: a visit_work_photo row that points at a
// stored work photo must appear in the referenced inventory, or the reaper
// would delete the attached file as an orphan. Empty values stay excluded like
// every other column in the union.
func TestReaperRepository_ListReferencedURLs_IncludesVisitWorkPhotos(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)

	locationID := seedLocation(t, pool, "POP Reaper Work Photo", "pop")
	vendorID := seedVendor(t, pool, "PT Reaper Work Photo")
	userID := seedUser(t, pool, seedUserParams{
		Name:  "Vendor Reaper Work Photo",
		Email: "reaper-work-photo@example.test",
		Role:  "vendor",
		Type:  "external",
	})
	visitID := seedVisit(t, pool, seedVisitParams{
		Code:       "VST-9000000024",
		VendorUser: userID,
		Vendor:     vendorID,
		Location:   locationID,
		Start:      time.Now().UTC(),
		End:        time.Now().UTC().Add(2 * time.Hour),
		Status:     domain.VisitStatusRequested,
	})

	const photoURL = "http://localhost:9000/thc-vms-bucket/work_photos/pending-actor-1/before.jpg"
	if _, err := pool.Exec(ctx,
		`INSERT INTO visit_work_photo (visit_request_id, kind, url, uploaded_by) VALUES ($1, 'before', $2, $3)`,
		uuidArg(visitID), photoURL, uuidArg(userID)); err != nil {
		t.Fatalf("seed visit work photo: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO visit_work_photo (visit_request_id, kind, url) VALUES ($1, 'after', '')`,
		uuidArg(visitID)); err != nil {
		t.Fatalf("seed empty work photo url: %v", err)
	}

	urls, err := NewReaperRepository(pool).ListReferencedURLs(ctx)
	if err != nil {
		t.Fatalf("ListReferencedURLs: %v", err)
	}

	found := false
	for _, raw := range urls {
		if raw == "" {
			t.Fatalf("empty URL leaked into the referenced inventory: %v", urls)
		}
		if raw == photoURL {
			found = true
		}
	}
	if !found {
		t.Fatalf("referenced URLs %v do not include work photo %q", urls, photoURL)
	}
}
