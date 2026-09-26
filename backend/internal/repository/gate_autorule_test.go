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
	pic := seedUser(t, pool, seedUserParams{Name: "PIC Gerbang", Email: "gerbang@vendor.test", Role: "pic", Type: "external"})
	guard := seedUser(t, pool, seedUserParams{Name: "Satpam Gerbang", Email: "satpam@thc.test", Role: "security", Location: loc, Type: "internal"})

	start := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
	visitID := seedVisit(t, pool, seedVisitParams{
		Code: "VST-0000000301", PIC: pic, Location: loc,
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
	pic := seedUser(t, pool, seedUserParams{Name: "PIC Keluar", Email: "keluar@vendor.test", Role: "pic", Type: "external"})
	guard := seedUser(t, pool, seedUserParams{Name: "Satpam Keluar", Email: "satpam.keluar@thc.test", Role: "security", Location: loc, Type: "internal"})

	start := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
	visitID := seedVisit(t, pool, seedVisitParams{
		Code: "VST-0000000302", PIC: pic, Location: loc,
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

// TestAutoRules_SweepsMatchThePRDThresholds seeds one matching and one
// non-matching row per rule and asserts exactly the matching rows return:
// R1 requested + created 8d ago (7-day timeout), R2 approved + ended 3h ago
// with no check-in (2h grace), R3 visiting + ended 25h ago (24h auto-complete).
func TestAutoRules_SweepsMatchThePRDThresholds(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	rules := NewVisitAutoRuleRepository(pool)
	gates := NewCheckInOutRepository(pool)
	now := time.Now().UTC().Truncate(time.Second)

	loc := seedLocation(t, pool, "Cabang Sweeper", "cabang")
	pic := seedUser(t, pool, seedUserParams{Name: "PIC Sweeper", Email: "sweep@vendor.test", Role: "pic", Type: "external"})
	guard := seedUser(t, pool, seedUserParams{Name: "Satpam Sweep", Email: "satpam.sweep@thc.test", Role: "security", Location: loc, Type: "internal"})

	window := func(start time.Time) (time.Time, time.Time) { return start, start.Add(4 * time.Hour) }

	// R1: stale requested (created 8d ago) vs fresh requested (created now).
	staleStart, staleEnd := window(now.Add(-8 * 24 * time.Hour))
	eightDaysAgo := now.Add(-8 * 24 * time.Hour)
	seedVisit(t, pool, seedVisitParams{Code: "VST-0000000311", PIC: pic, Location: loc, Start: staleStart, End: staleEnd, Status: domain.VisitStatusRequested, CreatedAt: &eightDaysAgo})
	freshStart, freshEnd := window(now.Add(24 * time.Hour))
	seedVisit(t, pool, seedVisitParams{Code: "VST-0000000312", PIC: pic, Location: loc, Start: freshStart, End: freshEnd, Status: domain.VisitStatusRequested})

	// R2: no-show (ended 3h ago, never checked in) vs checked-in vs future.
	oldStart, oldEnd := window(now.Add(-7 * time.Hour))
	seedVisit(t, pool, seedVisitParams{Code: "VST-0000000313", PIC: pic, Location: loc, Start: oldStart, End: oldEnd, Status: domain.VisitStatusApproved})
	checkedID := seedVisit(t, pool, seedVisitParams{Code: "VST-0000000314", PIC: pic, Location: loc, Start: oldStart, End: oldEnd, Status: domain.VisitStatusApproved})
	if _, err := gates.RecordCheckIn(ctx, domain.CheckIn{VisitRequestID: checkedID, CheckedInBy: guard}); err != nil {
		t.Fatalf("seed check-in for R2 exclusion: %v", err)
	}
	futureStart, futureEnd := window(now.Add(24 * time.Hour))
	seedVisit(t, pool, seedVisitParams{Code: "VST-0000000315", PIC: pic, Location: loc, Start: futureStart, End: futureEnd, Status: domain.VisitStatusApproved})

	// R3: overstayed visiting (ended 25h ago) vs just-ended visiting.
	overStart, overEnd := window(now.Add(-29 * time.Hour))
	seedVisit(t, pool, seedVisitParams{Code: "VST-0000000316", PIC: pic, Location: loc, Start: overStart, End: overEnd, Status: domain.VisitStatusVisiting})
	recentStart, recentEnd := window(now.Add(-5 * time.Hour))
	seedVisit(t, pool, seedVisitParams{Code: "VST-0000000317", PIC: pic, Location: loc, Start: recentStart, End: recentEnd, Status: domain.VisitStatusVisiting})

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
	assertCodes("R1 stale-requested", stale, map[string]bool{"VST-0000000311": true})

	noShow, err := rules.FindNoShowApproved(ctx, now)
	if err != nil {
		t.Fatalf("FindNoShowApproved: %v", err)
	}
	assertCodes("R2 no-show", noShow, map[string]bool{"VST-0000000313": true})

	overstayed, err := rules.FindOverstayedVisiting(ctx, now)
	if err != nil {
		t.Fatalf("FindOverstayedVisiting: %v", err)
	}
	assertCodes("R3 overstayed", overstayed, map[string]bool{"VST-0000000316": true})
}
