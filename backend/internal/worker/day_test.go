package worker_test

import (
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/worker"
)

func TestTodayBoundaries_UseTheFacilityTimezone(t *testing.T) {
	t.Parallel()
	// Given: a frozen instant that is 2026-09-26 00:30 in WIB but still
	// 2026-09-25 17:30 in UTC — the server zone and the facility zone
	// disagree about which calendar day it is.
	now := time.Date(2026, time.September, 25, 17, 30, 0, 0, time.UTC)
	loc, err := worker.LocationForTimezone(domain.TimezoneWIB)
	if err != nil {
		t.Fatalf("expected WIB location, got %v", err)
	}
	// When: the facility-day bounds are computed.
	start, end := worker.TodayBounds(now, loc)
	// Then: the day is the FACILITY day (Sep 26), exactly 24h wide.
	y, m, d := start.Date()
	if y != 2026 || m != time.September || d != 26 {
		t.Fatalf("expected facility day 2026-09-26, got %v", start)
	}
	if h, min, s := start.Clock(); h != 0 || min != 0 || s != 0 {
		t.Fatalf("expected midnight facility start, got %v", start)
	}
	if end.Sub(start) != 24*time.Hour {
		t.Fatalf("expected a 24h facility day, got %v", end.Sub(start))
	}
	if start.Location().String() != loc.String() {
		t.Fatalf("expected bounds in %v, got %v", loc, start.Location())
	}
	// And the server zone would have answered a different day.
	sy, sm, sd := now.UTC().Date()
	if sy == y && sm == m && sd == d {
		t.Fatal("test setup broken: UTC and WIB must disagree on the day")
	}
}

func TestLocationForTimezone_MapsFacilityZones(t *testing.T) {
	t.Parallel()
	// Given: the three facility timezone labels.
	cases := []struct {
		tz   domain.Timezone
		iana string
	}{
		{domain.TimezoneWIB, "Asia/Jakarta"},
		{domain.TimezoneWITA, "Asia/Makassar"},
		{domain.TimezoneWIT, "Asia/Jayapura"},
	}
	for _, tc := range cases {
		t.Run(string(tc.tz), func(t *testing.T) {
			t.Parallel()
			// When: the label is resolved.
			loc, err := worker.LocationForTimezone(tc.tz)
			// Then: the matching IANA zone loads.
			if err != nil {
				t.Fatalf("expected %s to resolve, got %v", tc.iana, err)
			}
			if loc.String() != tc.iana {
				t.Fatalf("expected %s, got %s", tc.iana, loc.String())
			}
		})
	}
}
