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

// TestHumanCancel_MandatoryBypassEmailsBothWays proves the human-cancel
// routing carries its mandatory bypass on both directions even when the
// matrix is stored all-Off: a vendor cancelling its own visit still mails the
// branch staff (admin+security in To, super_admins in Bcc), and an
// admin/superadmin cancelling still mails the vendor — with no mail the other
// way in either direction.
func TestHumanCancel_MandatoryBypassEmailsBothWays(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)

	loc := seedLocation(t, pool, "Cabang Batal Wajib", "cabang")
	vendor := seedUser(t, pool, seedUserParams{Name: "Vendor Batal", Email: "batal.wajib@vendor.test", Role: "vendor", Type: "external"})
	admin := seedUser(t, pool, seedUserParams{Name: "Admin Batal", Email: "admin.batal.wajib@thc.test", Role: "admin", Location: loc, Type: "internal"})
	security := seedUser(t, pool, seedUserParams{Name: "Security Batal", Email: "sec.batal.wajib@thc.test", Role: "security", Location: loc, Type: "internal"})
	superAdmin := seedUser(t, pool, seedUserParams{Name: "Super Batal", Email: "super.batal.wajib@thc.test", Role: "super_admin", Type: "internal"})
	fake := &domain.FakeMailer{}
	repos := NewVisitRepository(pool).WithMailer(fake).WithSettings(fixedSettingsLoader{snap: allOffSettings()})
	notifs := NewNotificationRepository(pool)

	start := time.Now().UTC().Add(24 * time.Hour).Truncate(time.Second)

	vendorVisit := seedVisit(t, pool, seedVisitParams{
		Code: "VST-0000000211", VendorUser: vendor, Location: loc,
		Start: start, End: start.Add(4 * time.Hour), Status: domain.VisitStatusRequested,
	})
	if err := repos.UpdateStatus(ctx, vendorVisit, domain.VisitStatusCancelled, vendor, "dibatalkan vendor"); err != nil {
		t.Fatalf("vendor cancel UpdateStatus: %v", err)
	}
	if len(fake.Calls) != 1 {
		t.Fatalf("email calls after vendor cancel = %d, want exactly 1 staff email (mandatory bypass)", len(fake.Calls))
	}
	staffCall := fake.Calls[0]
	wantTo := map[string]bool{"admin.batal.wajib@thc.test": true, "sec.batal.wajib@thc.test": true}
	if len(staffCall.To) != len(wantTo) {
		t.Fatalf("staff To = %v, want the branch admin+security", staffCall.To)
	}
	for _, addr := range staffCall.To {
		if !wantTo[addr] {
			t.Fatalf("staff To = %v, want only the branch admin+security", staffCall.To)
		}
		if addr == "batal.wajib@vendor.test" {
			t.Fatalf("staff To = %v, vendor must not be mailed its own cancel", staffCall.To)
		}
	}
	if len(staffCall.Bcc) != 1 || staffCall.Bcc[0] != "super.batal.wajib@thc.test" {
		t.Fatalf("staff Bcc = %v, want the national super_admin", staffCall.Bcc)
	}
	for _, staff := range []domain.UUID{superAdmin, admin, security} {
		if n := cancelledCount(t, notifs, ctx, staff, vendorVisit); n != 1 {
			t.Fatalf("staff in_app visit_cancelled rows = %d, want 1 (mandatory bypass)", n)
		}
	}
	if n := cancelledCount(t, notifs, ctx, vendor, vendorVisit); n != 0 {
		t.Fatalf("vendor in_app visit_cancelled rows = %d, want 0 on own cancel", n)
	}

	fake.Calls = nil
	adminVisit := seedVisit(t, pool, seedVisitParams{
		Code: "VST-0000000212", VendorUser: vendor, Location: loc,
		Start: start, End: start.Add(4 * time.Hour), Status: domain.VisitStatusRequested,
	})
	if err := repos.UpdateStatus(ctx, adminVisit, domain.VisitStatusCancelled, admin, "dibatalkan admin"); err != nil {
		t.Fatalf("admin cancel UpdateStatus: %v", err)
	}
	if len(fake.Calls) != 1 {
		t.Fatalf("email calls after admin cancel = %d, want exactly 1 vendor email (mandatory bypass)", len(fake.Calls))
	}
	vendorCall := fake.Calls[0]
	if len(vendorCall.To) != 1 || vendorCall.To[0] != "batal.wajib@vendor.test" {
		t.Fatalf("vendor To = %v, want the vendor user", vendorCall.To)
	}
	if len(vendorCall.Bcc) != 0 {
		t.Fatalf("vendor Bcc = %v, want empty", vendorCall.Bcc)
	}
	if n := cancelledCount(t, notifs, ctx, vendor, adminVisit); n != 1 {
		t.Fatalf("vendor in_app visit_cancelled rows = %d, want 1 (mandatory bypass)", n)
	}
	for _, staff := range []domain.UUID{superAdmin, admin, security} {
		if n := cancelledCount(t, notifs, ctx, staff, adminVisit); n != 0 {
			t.Fatalf("staff in_app visit_cancelled rows = %d, want 0 on admin cancel", n)
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
