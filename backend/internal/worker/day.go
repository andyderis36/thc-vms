package worker

import (
	"fmt"
	"time"

	"thc-vms/backend/internal/domain"
)

// LocationForTimezone resolves a facility timezone label (WIB/WITA/WIT from
// domain.Location) to its IANA zone for calendar math. The +/-2h check-in
// window and the 24h/7d thresholds are absolute instants and must NOT pass
// through here — only the "today" calendar notion uses the facility zone,
// never the server's zone.
func LocationForTimezone(tz domain.Timezone) (*time.Location, error) {
	switch tz {
	case domain.TimezoneWIB:
		return time.LoadLocation("Asia/Jakarta")
	case domain.TimezoneWITA:
		return time.LoadLocation("Asia/Makassar")
	case domain.TimezoneWIT:
		return time.LoadLocation("Asia/Jayapura")
	default:
		return nil, fmt.Errorf("worker: unknown facility timezone %q: %w", string(tz), domain.ErrValidation)
	}
}

// TodayBounds returns the facility-calendar day containing now as the
// half-open interval [dayStart, dayEnd): midnight to midnight in loc, exactly
// 24 hours wide. Callers filter "today" reads (PRD: security sees today)
// against these bounds.
func TodayBounds(now time.Time, loc *time.Location) (dayStart, dayEnd time.Time) {
	year, month, day := now.In(loc).Date()
	dayStart = time.Date(year, month, day, 0, 0, 0, 0, loc)
	return dayStart, dayStart.Add(24 * time.Hour)
}
