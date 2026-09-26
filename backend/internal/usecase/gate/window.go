package gate

import "time"

// CheckInTolerance is the gate grace period on both sides of the schedule:
// check-in is valid from start_date-2h up to end_date+2h (PRD L121-123,
// AGENTS.md rule 6.2). It is an absolute duration — no timezone conversion.
const CheckInTolerance = 2 * time.Hour

// WindowSide names which side of the check-in window a timestamp falls on,
// so callers can log the refusal direction without re-deriving it.
type WindowSide string

const (
	// WindowOpen means now is inside [start-2h, end+2h].
	WindowOpen WindowSide = "open"
	// WindowTooEarly means now precedes start-2h.
	WindowTooEarly WindowSide = "too_early"
	// WindowTooLate means now follows end+2h.
	WindowTooLate WindowSide = "too_late"
)

// InCheckInWindow reports whether now falls inside the inclusive tolerance
// window [start-2h, end+2h]. Both edges are inclusive: exactly start-2h and
// exactly end+2h are valid; one second outside either edge is refused.
func InCheckInWindow(start, end, now time.Time) bool {
	return CheckInWindowSide(start, end, now) == WindowOpen
}

// CheckInWindowSide reports which side of the tolerance window now falls on:
// open inside [start-2h, end+2h], too_early before it, too_late after it.
func CheckInWindowSide(start, end, now time.Time) WindowSide {
	if now.Before(start.Add(-CheckInTolerance)) {
		return WindowTooEarly
	}
	if now.After(end.Add(CheckInTolerance)) {
		return WindowTooLate
	}
	return WindowOpen
}
