package repository

// Gate + worker-rule suite: one check-in / one check-out per visit, and the
// three PRD auto-rule sweeps matching their thresholds.

import (
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
)

// Gate fixtures are staged inline per test: one visit plus its branch
// security officer, so each conflict assertion starts from a known row.

// TestDoubleCheckIn_ReturnsConflict proves the second check-in for one visit
// fails with ErrConflict instead of issuing a second badge.
func TestDoubleCheckIn_ReturnsConflict(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	gates := NewCheckInOutRepository(pool)

	loc := seedLocation(t, pool, "Cabang Gerbang", "cabang")
	vendor := seedUser(t, pool, seedUserParams{Name: "Vendor Gerbang", Email: "gerbang@vendor.test", Role: "vendor", Type: "external"})
	guard := seedUser(t, pool, seedUserParams{Name: "Pengawas Gerbang", Email: "security@thc.test", Role: "security", Location: loc, Type: "internal"})

	start := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
	visitID := seedVisit(t, pool, seedVisitParams{
		Code: "VST-0000000301", VendorUser: vendor, Location: loc,
		Start: start, End: start.Add(4 * time.Hour), Status: domain.VisitStatusApproved,
	})

	first, err := gates.RecordCheckIn(ctx, domain.CheckIn{VisitRequestID: visitID, CheckedInBy: guard})
	if err != nil {
		t.Fatalf("first RecordCheckIn: %v", err)
	}
	if first.VisitRequestID != visitID {
		t.Fatalf("check-in visit = %s, want %s", first.VisitRequestID, visitID)
	}
	if _, err := gates.RecordCheckIn(ctx, domain.CheckIn{VisitRequestID: visitID, CheckedInBy: guard}); err == nil {
		t.Fatalf("second check-in succeeded, want ErrConflict (RED: double badge issued)")
	} else {
		requireErrIs(t, err, domain.ErrConflict, "double check-in")
	}
	if _, err := gates.FindCheckInByVisit(ctx, visitID); err != nil {
		t.Fatalf("FindCheckInByVisit: %v", err)
	}
}

// TestDoubleCheckOut_ReturnsConflict proves the second check-out for one visit
// fails with ErrConflict instead of closing the visit twice.
func TestDoubleCheckOut_ReturnsConflict(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	gates := NewCheckInOutRepository(pool)

	loc := seedLocation(t, pool, "Cabang Keluar", "cabang")
	vendor := seedUser(t, pool, seedUserParams{Name: "Vendor Keluar", Email: "keluar@vendor.test", Role: "vendor", Type: "external"})
	guard := seedUser(t, pool, seedUserParams{Name: "Pengawas Keluar", Email: "security.keluar@thc.test", Role: "security", Location: loc, Type: "internal"})

	start := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
	visitID := seedVisit(t, pool, seedVisitParams{
		Code: "VST-0000000302", VendorUser: vendor, Location: loc,
		Start: start, End: start.Add(4 * time.Hour), Status: domain.VisitStatusVisiting,
	})

	if _, err := gates.RecordCheckOut(ctx, domain.CheckOut{VisitRequestID: visitID, CheckedOutBy: guard}); err != nil {
		t.Fatalf("first RecordCheckOut: %v", err)
	}
	if _, err := gates.RecordCheckOut(ctx, domain.CheckOut{VisitRequestID: visitID, CheckedOutBy: guard}); err == nil {
		t.Fatalf("second check-out succeeded, want ErrConflict (RED: visit closed twice)")
	} else {
		requireErrIs(t, err, domain.ErrConflict, "double check-out")
	}
}

// TestAutoRules_SweepsMatchThePRDThresholds seeds matching and non-matching
// rows per rule and asserts exactly the matching rows return: R1 requested +
// window started + inside its 2h end guard (start_date <= now, end_date >
// now-2h), R2 every pre-arrival status at end with no check-in (approved and
// rescheduled at the exact end; requested only once R1's guard excludes it),
// R3 visiting|offsite + end reached (no 24h delay).
func TestAutoRules_SweepsMatchThePRDThresholds(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	rules := NewVisitAutoRuleRepository(pool)
	gates := NewCheckInOutRepository(pool)
	now := time.Now().UTC().Truncate(time.Second)

	loc := seedLocation(t, pool, "Cabang Sweeper", "cabang")
	vendor := seedUser(t, pool, seedUserParams{Name: "Vendor Sweeper", Email: "sweep@vendor.test", Role: "vendor", Type: "external"})
	guard := seedUser(t, pool, seedUserParams{Name: "Pengawas Sweep", Email: "security.sweep@thc.test", Role: "security", Location: loc, Type: "internal"})

	window := func(start time.Time) (time.Time, time.Time) { return start, start.Add(4 * time.Hour) }

	// R1: requested with a STARTED window (start 1h ago, still inside the open
	// window) vs a requested visit whose window has not started yet. The
	// closed-1h-ago request is also R1's: its end still sits inside the 2h
	// guard, so R2 must not claim it.
	staleStart, staleEnd := window(now.Add(-time.Hour))
	seedVisit(t, pool, seedVisitParams{Code: "VST-0000000311", VendorUser: vendor, Location: loc, Start: staleStart, End: staleEnd, Status: domain.VisitStatusRequested})
	freshStart, freshEnd := window(now.Add(24 * time.Hour))
	seedVisit(t, pool, seedVisitParams{Code: "VST-0000000312", VendorUser: vendor, Location: loc, Start: freshStart, End: freshEnd, Status: domain.VisitStatusRequested})
	recentStart, recentEnd := window(now.Add(-5 * time.Hour))
	seedVisit(t, pool, seedVisitParams{Code: "VST-0000000323", VendorUser: vendor, Location: loc, Start: recentStart, End: recentEnd, Status: domain.VisitStatusRequested})

	// R2: every pre-arrival status at end with no check-in. Approved at 3h and
	// 1h past end, rescheduled 3h past end, and a requested permit 3h past end
	// (outside R1's 2h guard, so only R2 can reach it). The 1h rows pin the
	// removed 2h grace. Rows deliberately NOT listed: requested 1h past end
	// (R1's guard), approved with a check-in row, and any future window.
	oldStart, oldEnd := window(now.Add(-7 * time.Hour))
	seedVisit(t, pool, seedVisitParams{Code: "VST-0000000313", VendorUser: vendor, Location: loc, Start: oldStart, End: oldEnd, Status: domain.VisitStatusApproved})
	checkedID := seedVisit(t, pool, seedVisitParams{Code: "VST-0000000314", VendorUser: vendor, Location: loc, Start: oldStart, End: oldEnd, Status: domain.VisitStatusApproved})
	if _, err := gates.RecordCheckIn(ctx, domain.CheckIn{VisitRequestID: checkedID, CheckedInBy: guard}); err != nil {
		t.Fatalf("seed check-in for R2 exclusion: %v", err)
	}
	futureStart, futureEnd := window(now.Add(24 * time.Hour))
	seedVisit(t, pool, seedVisitParams{Code: "VST-0000000315", VendorUser: vendor, Location: loc, Start: futureStart, End: futureEnd, Status: domain.VisitStatusApproved})
	seedVisit(t, pool, seedVisitParams{Code: "VST-0000000318", VendorUser: vendor, Location: loc, Start: oldStart, End: oldEnd, Status: domain.VisitStatusRequested})
	seedVisit(t, pool, seedVisitParams{Code: "VST-0000000319", VendorUser: vendor, Location: loc, Start: oldStart, End: oldEnd, Status: domain.VisitStatusRescheduled})
	seedVisit(t, pool, seedVisitParams{Code: "VST-0000000322", VendorUser: vendor, Location: loc, Start: recentStart, End: recentEnd, Status: domain.VisitStatusApproved})
	seedVisit(t, pool, seedVisitParams{Code: "VST-0000000324", VendorUser: vendor, Location: loc, Start: futureStart, End: futureEnd, Status: domain.VisitStatusRescheduled})

	// R3: visiting/offsite at end datetime (25h ago and 1h ago) vs a permit
	// whose window has not ended yet. The 1h rows pin the removed 24h delay.
	overStart, overEnd := window(now.Add(-29 * time.Hour))
	seedVisit(t, pool, seedVisitParams{Code: "VST-0000000316", VendorUser: vendor, Location: loc, Start: overStart, End: overEnd, Status: domain.VisitStatusVisiting})
	seedVisit(t, pool, seedVisitParams{Code: "VST-0000000317", VendorUser: vendor, Location: loc, Start: recentStart, End: recentEnd, Status: domain.VisitStatusVisiting})
	seedVisit(t, pool, seedVisitParams{Code: "VST-0000000320", VendorUser: vendor, Location: loc, Start: recentStart, End: recentEnd, Status: domain.VisitStatusOffsite})
	unendedStart, unendedEnd := window(now.Add(24 * time.Hour))
	seedVisit(t, pool, seedVisitParams{Code: "VST-0000000321", VendorUser: vendor, Location: loc, Start: unendedStart, End: unendedEnd, Status: domain.VisitStatusVisiting})

	assertCodes := func(what string, visits []domain.VisitRequest, want map[string]bool) {
		t.Helper()
		if len(visits) != len(want) {
			got := make([]string, 0, len(visits))
			for _, v := range visits {
				got = append(got, v.VisitID)
			}
			t.Fatalf("%s = %v, want %d rows (RED: threshold drifted)", what, got, len(want))
		}
		for _, v := range visits {
			if !want[v.VisitID] {
				t.Fatalf("%s wrongly contains %s (RED: sweep over-matched)", what, v.VisitID)
			}
		}
	}

	stale, err := rules.FindStaleRequested(ctx, now)
	if err != nil {
		t.Fatalf("FindStaleRequested: %v", err)
	}
	assertCodes("R1 stale-requested", stale, map[string]bool{
		"VST-0000000311": true,
		"VST-0000000323": true,
	})

	noShow, err := rules.FindNoShow(ctx, now)
	if err != nil {
		t.Fatalf("FindNoShow: %v", err)
	}
	assertCodes("R2 no-show", noShow, map[string]bool{
		"VST-0000000313": true,
		"VST-0000000318": true,
		"VST-0000000319": true,
		"VST-0000000322": true,
	})

	overstayed, err := rules.FindOverstayedVisiting(ctx, now)
	if err != nil {
		t.Fatalf("FindOverstayedVisiting: %v", err)
	}
	assertCodes("R3 overstayed", overstayed, map[string]bool{
		"VST-0000000316": true,
		"VST-0000000317": true,
		"VST-0000000320": true,
	})
}

// TestAutoRules_NoShowWritesNullActorHistoryAndVendorNotice drives the full
// R2 path against PostgreSQL: the sweep lists an approved permit at end with
// no entry, the worker's UpdateStatus flips it to cancelled with the empty
// actor, and both the NULL-actor history row and the vendor auto-cancelled
// notice land.
func TestAutoRules_NoShowWritesNullActorHistoryAndVendorNotice(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	rules := NewVisitAutoRuleRepository(pool)
	visits := NewVisitRepository(pool)
	notifs := NewNotificationRepository(pool)
	now := time.Now().UTC().Truncate(time.Second)

	loc := seedLocation(t, pool, "Cabang NoShow", "cabang")
	vendorUser := seedUser(t, pool, seedUserParams{Name: "Vendor NoShow", Email: "vendor.noshow@vendor.test", Role: "vendor", Type: "external"})

	visitID := seedVisit(t, pool, seedVisitParams{
		Code: "VST-0000000321", VendorUser: vendorUser, Location: loc,
		Start: now.Add(-7 * time.Hour), End: now.Add(-3 * time.Hour),
		Status: domain.VisitStatusApproved,
	})

	candidates, err := rules.FindNoShow(ctx, now)
	if err != nil {
		t.Fatalf("FindNoShow: %v", err)
	}
	if len(candidates) != 1 || candidates[0].ID != visitID {
		t.Fatalf("FindNoShow = %+v, want the approved permit at end with no entry", candidates)
	}

	if err := visits.UpdateStatus(ctx, visitID, domain.VisitStatusCancelled, "", "auto-rule R2"); err != nil {
		t.Fatalf("UpdateStatus(cancelled): %v", err)
	}

	got, err := visits.FindByID(ctx, visitID)
	if err != nil {
		t.Fatalf("FindByID: %v", err)
	}
	if got.Status != domain.VisitStatusCancelled {
		t.Fatalf("status = %s, want cancelled", got.Status)
	}
	rows := historyRows(t, pool, visitID)
	if len(rows) != 1 {
		t.Fatalf("history rows = %d, want exactly 1", len(rows))
	}
	if rows[0].Status != string(domain.VisitStatusCancelled) {
		t.Fatalf("history status = %s, want cancelled", rows[0].Status)
	}
	if rows[0].ChangedBy.Valid {
		t.Fatalf("changed_by is set, want SQL NULL for the automatic transition")
	}

	items, total, _, err := notifs.List(ctx, domain.NotificationFilter{UserID: vendorUser, Page: 1, Limit: 100})
	if err != nil {
		t.Fatalf("list notifications: %v", err)
	}
	if total != 1 || len(items) != 1 {
		t.Fatalf("notifications = %d (total %d), want 1 vendor notice", len(items), total)
	}
	if items[0].Type != domain.NotificationVisitAutoCancelled {
		t.Fatalf("notification type = %q, want %q", items[0].Type, domain.NotificationVisitAutoCancelled)
	}
}
