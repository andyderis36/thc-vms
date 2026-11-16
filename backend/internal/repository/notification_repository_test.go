package repository

import (
	"testing"
	"time"

	"github.com/google/uuid"

	"thc-vms/backend/internal/domain"
)

// The persisted store de-duplicates at write time via the
// (user_id, type, visit_request_id) unique constraint: replaying the same
// lifecycle (a status_history 'visiting' row ADD a gate check_in row) must yield
// exactly ONE visit_check_in notification, never two.
func TestNotification_CheckInYieldsExactlyOne(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)

	loc := seedLocation(t, pool, "POP Notif", "pop")
	vendorUser := seedUser(t, pool, seedUserParams{Name: "Vendor/Mitra", Email: "vendor@notif.local", Role: "vendor", Type: "external"})
	visitID := seedVisit(t, pool, seedVisitParams{
		Code: "VST-0000000001", VendorUser: vendorUser, Location: loc,
		Start: time.Now().Add(time.Hour), End: time.Now().Add(2 * time.Hour),
		Status: domain.VisitStatusVisiting,
	})

	// Simulate lifecycle history rows, including the 'visiting' row that must
	// NOT become a second check-in notification next to the gate row below.
	_, err := pool.Exec(ctx, `INSERT INTO status_history (visit_request_id, status, changed_at) VALUES ($1, 'requested', now() - interval '1 hour')`, uuidArg(visitID))
	if err != nil {
		t.Fatalf("seed requested history: %v", err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO status_history (visit_request_id, status, changed_at) VALUES ($1, 'visiting', now())`, uuidArg(visitID))
	if err != nil {
		t.Fatalf("seed visiting history: %v", err)
	}

	// One gate check-in row, whose recipient is the branch security officer.
	security := seedUser(t, pool, seedUserParams{Name: "Sec", Email: "sec@notif.local", Role: "security", Location: loc, Type: "internal"})
	_, err = pool.Exec(ctx, `INSERT INTO check_in (visit_request_id, checked_in_at, checked_in_by) VALUES ($1, now(), $2)`, uuidArg(visitID), uuidArg(security))
	if err != nil {
		t.Fatalf("seed check_in: %v", err)
	}

	// Replay the lifecycle history into the store, twice: the second run must be
	// a no-op thanks to Oa CONFLICT DO NOTHING.
	if _, err := BackfillNotifications(ctx, pool); err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if _, err := BackfillNotifications(ctx, pool); err != nil {
		t.Fatalf("backfill rerun: %v", err)
	}

	repo := NewNotificationRepository(pool)
	locPtr := loc
	items, total, _, err := repo.List(ctx, domain.NotificationFilter{UserID: security, LocationID: &locPtr, Page: 1, Limit: 100})
	if err != nil {
		t.Fatalf("list: %v", err)
	}

	checkInCount := 0
	for _, it := range items {
		if it.Type == domain.NotificationVisitCheckIn {
			checkInCount++
		}
	}
	if checkInCount != 1 {
		t.Fatalf("check-in notifications = %d, want 1 (no duplicate from status_history)", checkInCount)
	}
	// The security roster is not an approver, so the visit_requested bell
	// never reaches it: the feed holds the check_in row only. A broken
	// de-dup would make the check-in count 2 (asserted above).
	if total != 1 {
		t.Fatalf("total = %d, want 1 (check_in only: visit_requested is admin-only)", total)
	}
}

// A vendor's feed must be hard-scoped to its own rows (WHERE n.user_id = caller).
// A notice persisted for a different vendor must never appear in the caller's
// list, count or unread badge - removing that predicate makes this test fail.
func TestNotification_VendorListIsolatedToOwnRows(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)

	loc := seedLocation(t, pool, "POP Notif Iso", "pop")
	vendorA := seedUser(t, pool, seedUserParams{Name: "Vendor A", Email: "vendor.a@notif.local", Role: "vendor", Type: "external"})
	vendorB := seedUser(t, pool, seedUserParams{Name: "Vendor B", Email: "vendor.b@notif.local", Role: "vendor", Type: "external"})
	visitA := seedVisit(t, pool, seedVisitParams{
		Code: "VST-0000000101", VendorUser: vendorA, Location: loc,
		Start: time.Now().Add(time.Hour), End: time.Now().Add(2 * time.Hour),
		Status: domain.VisitStatusApproved,
	})
	visitB := seedVisit(t, pool, seedVisitParams{
		Code: "VST-0000000102", VendorUser: vendorB, Location: loc,
		Start: time.Now().Add(time.Hour), End: time.Now().Add(2 * time.Hour),
		Status: domain.VisitStatusApproved,
	})

	var ownID uuid.UUID
	err := pool.QueryRow(ctx, `INSERT INTO notification (user_id, visit_request_id, type, title, message)
		VALUES ($1, $2, 'visit_approved', $3, $4) RETURNING id`,
		uuidArg(vendorA), uuidArg(visitA), "Kunjungan disetujui", "Permintaan A disetujui").Scan(&ownID)
	if err != nil {
		t.Fatalf("seed vendor A notification: %v", err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO notification (user_id, visit_request_id, type, title, message)
		VALUES ($1, $2, 'visit_approved', $3, $4)`,
		uuidArg(vendorB), uuidArg(visitB), "Kunjungan disetujui", "Permintaan B disetujui")
	if err != nil {
		t.Fatalf("seed vendor B notification: %v", err)
	}

	repo := NewNotificationRepository(pool)
	items, total, unread, err := repo.List(ctx, domain.NotificationFilter{UserID: vendorA, Page: 1, Limit: 100})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if total != 1 {
		t.Fatalf("total = %d, want 1 (only the caller's own notice)", total)
	}
	if len(items) != 1 {
		t.Fatalf("items = %d, want 1 (foreign notice leaked)", len(items))
	}
	if items[0].ID != toDomainUUID(ownID) {
		t.Fatalf("leaked foreign notification: got id %v want own %v", items[0].ID, toDomainUUID(ownID))
	}
	if unread != 1 {
		t.Fatalf("unread = %d, want 1 (caller's own unread only)", unread)
	}
}
