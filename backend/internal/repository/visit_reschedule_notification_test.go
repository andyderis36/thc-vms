package repository

// Regression suite for the reschedule bell refresh: a repeat reschedule must
// UPDATE the existing visit_rescheduled bell row (message + created_at) instead
// of keeping the first emission's content forever, while still producing
// exactly ONE row per audience (the idempotency E2E expectation).

import (
	"context"
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
)

// TestReschedule_RepeatRefreshesBellRow proves the bell follows the latest
// reschedule: rescheduling twice with different reasons leaves exactly one
// visit_rescheduled row per audience, and that row carries the SECOND
// emission's message and timestamp (not the first reason frozen in place).
func TestReschedule_RepeatRefreshesBellRow(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	repos := NewVisitRepository(pool)
	notifs := NewNotificationRepository(pool)

	loc := seedLocation(t, pool, "Cabang Jadwal", "cabang")
	vendor := seedUser(t, pool, seedUserParams{Name: "Vendor Jadwal", Email: "jadwal@vendor.test", Role: "vendor", Type: "external"})
	admin := seedUser(t, pool, seedUserParams{Name: "Admin Jadwal", Email: "admin.jadwal@thc.test", Role: "admin", Location: loc, Type: "internal"})
	superAdmin := seedUser(t, pool, seedUserParams{Name: "Super Jadwal", Email: "super.jadwal@thc.test", Role: "super_admin", Type: "internal"})

	start := time.Now().UTC().Add(72 * time.Hour).Truncate(time.Second)
	visit := seedVisit(t, pool, seedVisitParams{
		Code: "VST-0000000401", VendorUser: vendor, Location: loc,
		Start: start, End: start.Add(4 * time.Hour), Status: domain.VisitStatusRequested,
	})

	// First reschedule: exactly one bell row per audience.
	w1 := start.Add(24 * time.Hour)
	if err := repos.Reschedule(ctx, visit, w1, w1.Add(4*time.Hour), admin, "genset telat, geser sehari"); err != nil {
		t.Fatalf("first Reschedule: %v", err)
	}
	firstVendor := singleRescheduledRow(t, notifs, ctx, vendor, visit)
	firstStaff := singleRescheduledRow(t, notifs, ctx, admin, visit)
	singleRescheduledRow(t, notifs, ctx, superAdmin, visit)

	// The vendor reads the first notice: the refresh must update content, not
	// the read state.
	if _, err := notifs.MarkRead(ctx, firstVendor.ID, vendor); err != nil {
		t.Fatalf("mark first vendor row read: %v", err)
	}

	// Second reschedule with a different reason and window.
	w2 := start.Add(48 * time.Hour)
	if err := repos.Reschedule(ctx, visit, w2, w2.Add(4*time.Hour), admin, "menara banjir, geser dua hari"); err != nil {
		t.Fatalf("second Reschedule: %v", err)
	}

	// Still exactly one row per audience (no duplicate bell).
	secondVendor := singleRescheduledRow(t, notifs, ctx, vendor, visit)
	secondStaff := singleRescheduledRow(t, notifs, ctx, admin, visit)
	singleRescheduledRow(t, notifs, ctx, superAdmin, visit)

	// ...but each row now reflects the SECOND emission.
	wantMessage := "Permintaan VST-0000000401 dijadwalkan ulang. Alasan: menara banjir, geser dua hari"
	for name, pair := range map[string][2]domain.Notification{
		"vendor": {firstVendor, secondVendor},
		"staff":  {firstStaff, secondStaff},
	} {
		first, second := pair[0], pair[1]
		if second.Message != wantMessage {
			t.Fatalf("%s message = %q, want the second emission %q", name, second.Message, wantMessage)
		}
		if !second.OccurredAt.After(first.OccurredAt) {
			t.Fatalf("%s occurred_at = %v, want after the first emission %v (row was not refreshed)", name, second.OccurredAt, first.OccurredAt)
		}
		if second.ID != first.ID {
			t.Fatalf("%s row id changed %v -> %v, want the same row updated in place", name, first.ID, second.ID)
		}
	}

	// The refresh is content-only: the vendor's read flag survives.
	if !secondVendor.IsRead {
		t.Fatalf("vendor row is_read = false after refresh, want the read flag preserved")
	}
}

// singleRescheduledRow returns the caller's sole visit_rescheduled notice for
// one visit, failing when the count is anything but exactly one.
func singleRescheduledRow(t *testing.T, repo domain.NotificationRepository, ctx context.Context, user, visit domain.UUID) domain.Notification {
	t.Helper()
	items, _, _, err := repo.List(ctx, domain.NotificationFilter{UserID: user, Page: 1, Limit: 100})
	if err != nil {
		t.Fatalf("list notifications: %v", err)
	}
	var got []domain.Notification
	for _, it := range items {
		if it.Type == domain.NotificationVisitRescheduled && it.VisitRequestID == visit {
			got = append(got, it)
		}
	}
	if len(got) != 1 {
		t.Fatalf("visit_rescheduled rows = %d, want exactly 1", len(got))
	}
	return got[0]
}
