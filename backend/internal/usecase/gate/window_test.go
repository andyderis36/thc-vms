package gate_test

import (
	"errors"
	"strings"
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/gate"
)

// exactWindowMessage is the PRD-authoritative string for BOTH the too-early
// and too-late refusal (PRD L123); QA GATE-04/GATE-05 paraphrase it.
const exactWindowMessage = "Kunjungan belum dibuka atau sudah melewati batas waktu toleransi."

func TestInCheckInWindow_AllowsNinetyMinutesEarly(t *testing.T) {
	t.Parallel()
	// Given: a visit starting 90 minutes after the frozen now.
	start := fixedNow.Add(90 * time.Minute)
	end := start.Add(2 * time.Hour)
	// When: the pure window predicate is evaluated.
	// Then: QA GATE-03 holds — inside the -2h tolerance, check-in is allowed.
	if !gate.InCheckInWindow(start, end, fixedNow) {
		t.Fatal("expected InCheckInWindow to allow a visit starting in 90 minutes")
	}
}

func TestInCheckInWindow_RejectsThreeHoursEarly(t *testing.T) {
	t.Parallel()
	// Given: a visit starting 3h after now, guarded by security on its branch.
	start := fixedNow.Add(3 * time.Hour)
	end := start.Add(2 * time.Hour)
	visit := visitFixture("visit-early", domain.VisitStatusApproved, start, end)
	visits := newFakeVisitRepo(visit)
	checks := newFakeCheckInOutRepo()
	svc := gate.NewService(gate.Dependencies{
		Visits:   visits,
		CheckIns: checks,
		Clock:    &stubClock{now: fixedNow},
	})
	actor := gate.Actor{ID: "sec-1", Role: domain.RoleSecurity, LocationID: uuidPtr("loc-A")}
	// When: check-in runs outside the window on the early side.
	_, err := svc.CheckIn(t.Context(), actor, string(visit.ID), gate.CheckInInput{})
	// Then: the pure predicate refuses AND the service reports the exact PRD string.
	if gate.InCheckInWindow(start, end, fixedNow) {
		t.Fatal("expected InCheckInWindow to refuse a visit starting in 3 hours")
	}
	if err == nil {
		t.Fatal("expected a window error, got nil")
	}
	if !errors.Is(err, domain.ErrCheckInWindow) {
		t.Fatalf("expected ErrCheckInWindow, got %v", err)
	}
	if !strings.Contains(err.Error(), exactWindowMessage) {
		t.Fatalf("expected exact PRD message %q, got %q", exactWindowMessage, err.Error())
	}
}

func TestInCheckInWindow_RejectsThreeHoursAfterEnd(t *testing.T) {
	t.Parallel()
	// Given: a visit whose end was 3h before now (window closed 1h ago).
	start := fixedNow.Add(-6 * time.Hour)
	end := fixedNow.Add(-3 * time.Hour)
	visit := visitFixture("visit-late", domain.VisitStatusApproved, start, end)
	visits := newFakeVisitRepo(visit)
	checks := newFakeCheckInOutRepo()
	svc := gate.NewService(gate.Dependencies{
		Visits:   visits,
		CheckIns: checks,
		Clock:    &stubClock{now: fixedNow},
	})
	actor := gate.Actor{ID: "sec-1", Role: domain.RoleSecurity, LocationID: uuidPtr("loc-A")}
	// When: check-in runs outside the window on the late side.
	_, err := svc.CheckIn(t.Context(), actor, string(visit.ID), gate.CheckInInput{})
	// Then: refused with the SAME exact PRD string as the too-early case.
	if gate.InCheckInWindow(start, end, fixedNow) {
		t.Fatal("expected InCheckInWindow to refuse a visit that ended 3 hours ago")
	}
	if err == nil {
		t.Fatal("expected a window error, got nil")
	}
	if !errors.Is(err, domain.ErrCheckInWindow) {
		t.Fatalf("expected ErrCheckInWindow, got %v", err)
	}
	if !strings.Contains(err.Error(), exactWindowMessage) {
		t.Fatalf("expected exact PRD message %q, got %q", exactWindowMessage, err.Error())
	}
}

func TestInCheckInWindow_BoundariesAreInclusive(t *testing.T) {
	t.Parallel()
	// Given: a fixed visit window.
	start := fixedNow.Add(-time.Hour)
	end := fixedNow.Add(time.Hour)
	openAt := start.Add(-2 * time.Hour)
	closeAt := end.Add(2 * time.Hour)
	// When/Then: exactly start-2h and exactly end+2h are allowed (inclusive),
	// one second outside either edge is refused.
	cases := []struct {
		name string
		now  time.Time
		want bool
	}{
		{"exactly start-2h allowed", openAt, true},
		{"one second before start-2h refused", openAt.Add(-time.Second), false},
		{"exactly end+2h allowed", closeAt, true},
		{"one second after end+2h refused", closeAt.Add(time.Second), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := gate.InCheckInWindow(start, end, tc.now); got != tc.want {
				t.Fatalf("InCheckInWindow(start, end, %v) = %v, want %v", tc.now, got, tc.want)
			}
		})
	}
}
