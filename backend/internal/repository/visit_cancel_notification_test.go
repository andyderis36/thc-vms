package repository

// Regression suite for the human-cancel notification path: a human-driven
// cancellation must persist its visit_cancelled notice in the SAME
// transaction as the status move. Migration 000019 widened
// chk_notification_type to admit the 9th value; without it the emit violates
// the CHECK and the whole cancellation rolls back.

import (
	"context"
	"errors"
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
)

// TestUpdateStatus_HumanCancelWritesVisitCancelled proves both routings of
// HumanCancelledNotification land in the store: a vendor cancelling its own
// visit notifies the branch staff (super_admin + branch admin/security), and
// an admin cancelling notifies the vendor. A repeat cancel is a conflict and
// must not duplicate the notice.
func TestUpdateStatus_HumanCancelWritesVisitCancelled(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	repos := NewVisitRepository(pool)
	notifs := NewNotificationRepository(pool)

	loc := seedLocation(t, pool, "Cabang Batal", "cabang")
	vendor := seedUser(t, pool, seedUserParams{Name: "Vendor Batal", Email: "batal@vendor.test", Role: "vendor", Type: "external"})
	admin := seedUser(t, pool, seedUserParams{Name: "Admin Batal", Email: "admin.batal@thc.test", Role: "admin", Location: loc, Type: "internal"})
	security := seedUser(t, pool, seedUserParams{Name: "Security Batal", Email: "sec.batal@thc.test", Role: "security", Location: loc, Type: "internal"})
	superAdmin := seedUser(t, pool, seedUserParams{Name: "Super Batal", Email: "super.batal@thc.test", Role: "super_admin", Type: "internal"})

	start := time.Now().UTC().Add(24 * time.Hour).Truncate(time.Second)

	// Vendor cancels its own visit: the staff audience must gain exactly one
	// visit_cancelled row each, the vendor itself none.
	vendorVisit := seedVisit(t, pool, seedVisitParams{
		Code: "VST-0000000201", VendorUser: vendor, Location: loc,
		Start: start, End: start.Add(4 * time.Hour), Status: domain.VisitStatusRequested,
	})
	if err := repos.UpdateStatus(ctx, vendorVisit, domain.VisitStatusCancelled, vendor, "dibatalkan vendor"); err != nil {
		t.Fatalf("vendor cancel UpdateStatus: %v (CHECK violation here means 000019 is missing)", err)
	}
	for _, staff := range []domain.UUID{superAdmin, admin, security} {
		if n := cancelledCount(t, notifs, ctx, staff, vendorVisit); n != 1 {
			t.Fatalf("staff visit_cancelled rows = %d, want exactly 1", n)
		}
	}
	if n := cancelledCount(t, notifs, ctx, vendor, vendorVisit); n != 0 {
		t.Fatalf("vendor visit_cancelled rows = %d, want 0 on own cancel", n)
	}

	// Repeat cancel hits the same-status guard and must not duplicate rows.
	if err := repos.UpdateStatus(ctx, vendorVisit, domain.VisitStatusCancelled, vendor, "batal lagi"); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("repeat cancel err = %v, want ErrConflict", err)
	}
	for _, staff := range []domain.UUID{superAdmin, admin, security} {
		if n := cancelledCount(t, notifs, ctx, staff, vendorVisit); n != 1 {
			t.Fatalf("staff visit_cancelled rows after repeat = %d, want still 1", n)
		}
	}

	// Admin cancels a vendor visit: only the vendor is notified.
	adminVisit := seedVisit(t, pool, seedVisitParams{
		Code: "VST-0000000202", VendorUser: vendor, Location: loc,
		Start: start, End: start.Add(4 * time.Hour), Status: domain.VisitStatusRequested,
	})
	if err := repos.UpdateStatus(ctx, adminVisit, domain.VisitStatusCancelled, admin, "dibatalkan admin"); err != nil {
		t.Fatalf("admin cancel UpdateStatus: %v", err)
	}
	if n := cancelledCount(t, notifs, ctx, vendor, adminVisit); n != 1 {
		t.Fatalf("vendor visit_cancelled rows = %d, want exactly 1", n)
	}
	for _, staff := range []domain.UUID{superAdmin, admin, security} {
		if n := cancelledCount(t, notifs, ctx, staff, adminVisit); n != 0 {
			t.Fatalf("staff visit_cancelled rows = %d, want 0 on admin cancel", n)
		}
	}
}

// cancelledCount counts the caller's visit_cancelled notices for one visit.
func cancelledCount(t *testing.T, repo domain.NotificationRepository, ctx context.Context, user, visit domain.UUID) int {
	t.Helper()
	items, _, _, err := repo.List(ctx, domain.NotificationFilter{UserID: user, Page: 1, Limit: 100})
	if err != nil {
		t.Fatalf("list notifications: %v", err)
	}
	n := 0
	for _, it := range items {
		if it.Type == domain.NotificationVisitCancelled && it.VisitRequestID == visit {
			n++
		}
	}
	return n
}
