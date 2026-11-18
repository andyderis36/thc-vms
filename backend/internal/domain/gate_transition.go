package domain

// GateAction is the single staff gate intent behind a multi-entry permit
// move: check-in brings the team on site, check-out sends them off site
// while the permit stays active (plan .omo/plans/multi-entry-permit.md
// section 5). Manual completion and cancellation travel other paths.
type GateAction string

const (
	GateActionCheckIn  GateAction = "checkin"
	GateActionCheckOut GateAction = "checkout"
)

// ResolveGateTransition maps one gate scan onto the next visit status for a
// multi-entry permit. It is pure: window checks ([start-2h, end]), role and
// branch scoping stay in the usecase/worker layers (waves 2/3), never here.
//
// Allowed: approved+checkin -> visiting, visiting+checkout -> offsite,
// offsite+checkin -> visiting. Everything else is rejected, including both
// directions out of a terminal status and the same-direction double scan.
func ResolveGateTransition(current VisitStatus, action GateAction) (VisitStatus, bool) {
	switch {
	case current == VisitStatusApproved && action == GateActionCheckIn:
		return VisitStatusVisiting, true
	case current == VisitStatusVisiting && action == GateActionCheckOut:
		return VisitStatusOffsite, true
	case current == VisitStatusOffsite && action == GateActionCheckIn:
		return VisitStatusVisiting, true
	default:
		return VisitStatusNone, false
	}
}
