// Package domain holds the business vocabulary of the THC visitor-management
// system: entities, the visit state machine, ports and errors. It depends on
// the standard library only, so the inner layer can never drag in a driver.
package domain

import (
	"fmt"
	"slices"
	"time"
)

// VisitStatus is the lifecycle state of a visit request. The vocabulary is
// fixed by the PRD state machine (section 5) and the openapi VisitStatus
// enum: exactly these eight values exist, and the lowercase strings are the
// values stored in the database and exchanged over the API.
type VisitStatus string

const (
	// VisitStatusNone is the pseudo-origin of a brand-new submission: a visit
	// that has never held a status can only become requested.
	VisitStatusNone VisitStatus = ""
	// VisitStatusRequested is assigned when a vendor or admin submits the form.
	VisitStatusRequested VisitStatus = "requested"
	// VisitStatusApproved is assigned when a branch admin approves.
	VisitStatusApproved VisitStatus = "approved"
	// VisitStatusVisiting marks a guest who has checked in at the gate.
	VisitStatusVisiting VisitStatus = "visiting"
	// VisitStatusCompleted marks a visit closed by check-out or auto-complete.
	VisitStatusCompleted VisitStatus = "completed"
	// VisitStatusNotVisit marks a visit whose window closed without a check-in
	// (no show): an approved visit that never arrived, or an overdue request /
	// reschedule that was never approved and never visited.
	VisitStatusNotVisit VisitStatus = "not_visit"
	// VisitStatusRejected marks a request the branch admin refused.
	VisitStatusRejected VisitStatus = "rejected"
	// VisitStatusCancelled marks a request withdrawn before day H.
	VisitStatusCancelled VisitStatus = "cancelled"
	// VisitStatusRescheduled holds a visit whose dates are being renegotiated.
	VisitStatusRescheduled VisitStatus = "rescheduled"
)

// NoShowGrace is the R2 no-show horizon: once now passes end_date+NoShowGrace
// the check-in window [start_date-2h, end_date+2h] has fully closed, so a visit
// still in a pre-arrival status with no check-in row is a definitive no-show
// (AGENTS.md rule 6.2, PRD L142). The worker and the sweep repository both
// derive their threshold from this one value.
const NoShowGrace = 2 * time.Hour

// AllVisitStatuses returns the eight statuses in enum order.
func AllVisitStatuses() []VisitStatus {
	return []VisitStatus{
		VisitStatusRequested,
		VisitStatusApproved,
		VisitStatusVisiting,
		VisitStatusCompleted,
		VisitStatusNotVisit,
		VisitStatusRejected,
		VisitStatusCancelled,
		VisitStatusRescheduled,
	}
}

// ParseVisitStatus converts a stored or received string back into the typed
// vocabulary, refusing anything outside the eight legal values.
func ParseVisitStatus(raw string) (VisitStatus, error) {
	status := VisitStatus(raw)
	if status == VisitStatusNone || !slices.Contains(AllVisitStatuses(), status) {
		return VisitStatusNone, fmt.Errorf("%w: %q", ErrUnknownVisitStatus, raw)
	}
	return status, nil
}

// TransitionTrigger names the business cause behind one state-machine edge.
// visiting->completed appears twice on purpose: the PRD closes a visit
// either through a manual check-out or through the auto-complete worker
// (end_date + 24h), and the worker must be able to tell the two apart.
type TransitionTrigger string

const (
	TriggerSubmit       TransitionTrigger = "submit"
	TriggerApprove      TransitionTrigger = "approve"
	TriggerReject       TransitionTrigger = "reject"
	TriggerCancel       TransitionTrigger = "cancel"
	TriggerCheckIn      TransitionTrigger = "check_in"
	TriggerReschedule   TransitionTrigger = "reschedule"
	TriggerNoShow       TransitionTrigger = "no_show"
	TriggerCheckOut     TransitionTrigger = "check_out"
	TriggerAutoComplete TransitionTrigger = "auto_complete"
)

// Transition is one legal edge of the visit state machine.
type Transition struct {
	From    VisitStatus
	To      VisitStatus
	Trigger TransitionTrigger
}

// allowedTransitions is the complete rule set from the PRD state machine
// (docs/0. PRD section 5): sixteen edges, no more. Anything absent from this
// list is refused by CanTransition, including the moves the diagram only
// forbids by omission (rescheduled->visiting, approved->rejected, and every
// exit from a terminal status).
//
// requested->not_visit and rescheduled->not_visit close an unapproved request
// or reschedule whose window passed with no check-in, so the R2 no-show rule
// owns every pre-arrival status.
//
// A schedule change may be moved again without re-approval:
// rescheduled->rescheduled lets a visit be rescheduled repeatedly, and
// requested->rescheduled lets a vendor move the window of a request that has
// not been approved yet. Check-in still needs approval first:
// rescheduled->visiting stays forbidden, so a rescheduled visit must travel
// rescheduled->approved before the gate lets it in. The rescheduled status is
// informational (badge + history) on top of that rule.
var allowedTransitions = []Transition{
	{From: VisitStatusNone, To: VisitStatusRequested, Trigger: TriggerSubmit},
	{From: VisitStatusRequested, To: VisitStatusApproved, Trigger: TriggerApprove},
	{From: VisitStatusRequested, To: VisitStatusRejected, Trigger: TriggerReject},
	{From: VisitStatusRequested, To: VisitStatusCancelled, Trigger: TriggerCancel},
	{From: VisitStatusRequested, To: VisitStatusRescheduled, Trigger: TriggerReschedule},
	{From: VisitStatusRequested, To: VisitStatusNotVisit, Trigger: TriggerNoShow},
	{From: VisitStatusApproved, To: VisitStatusVisiting, Trigger: TriggerCheckIn},
	{From: VisitStatusApproved, To: VisitStatusRescheduled, Trigger: TriggerReschedule},
	{From: VisitStatusApproved, To: VisitStatusCancelled, Trigger: TriggerCancel},
	{From: VisitStatusApproved, To: VisitStatusNotVisit, Trigger: TriggerNoShow},
	{From: VisitStatusRescheduled, To: VisitStatusApproved, Trigger: TriggerApprove},
	{From: VisitStatusRescheduled, To: VisitStatusRescheduled, Trigger: TriggerReschedule},
	{From: VisitStatusRescheduled, To: VisitStatusCancelled, Trigger: TriggerCancel},
	{From: VisitStatusRescheduled, To: VisitStatusNotVisit, Trigger: TriggerNoShow},
	{From: VisitStatusVisiting, To: VisitStatusCompleted, Trigger: TriggerCheckOut},
	{From: VisitStatusVisiting, To: VisitStatusCompleted, Trigger: TriggerAutoComplete},
}

// AllTransitions returns a copy of the sixteen legal edges.
func AllTransitions() []Transition {
	return slices.Clone(allowedTransitions)
}

// TransitionTriggersFrom lists the triggers that move a visit from one status
// to another. It is empty when the move is illegal.
func TransitionTriggersFrom(from, to VisitStatus) []TransitionTrigger {
	var triggers []TransitionTrigger
	for _, transition := range allowedTransitions {
		if transition.From == from && transition.To == to {
			triggers = append(triggers, transition.Trigger)
		}
	}
	return triggers
}

// TransitionError describes one refused state-machine move. It unwraps to
// ErrInvalidTransition so callers match it with errors.Is; the message keeps
// the concrete pair for server-side logs, while the client-facing text is
// fixed by FromError.
type TransitionError struct {
	From VisitStatus
	To   VisitStatus
}

// NewInvalidTransition builds the refusal for one illegal move.
func NewInvalidTransition(from, to VisitStatus) *TransitionError {
	return &TransitionError{From: from, To: to}
}

func (e *TransitionError) Error() string {
	from := string(e.From)
	if from == "" {
		from = "(none)"
	}
	return fmt.Sprintf("%s: %s -> %s", ErrInvalidTransition, from, e.To)
}

// Unwrap exposes the sentinel so errors.Is finds ErrInvalidTransition.
func (e *TransitionError) Unwrap() error {
	return ErrInvalidTransition
}

// CanTransition reports whether a visit may move from one status to another,
// returning nil for the sixteen legal edges and a *TransitionError wrapping
// ErrInvalidTransition for everything else.
func CanTransition(from, to VisitStatus) error {
	if len(TransitionTriggersFrom(from, to)) > 0 {
		return nil
	}
	return NewInvalidTransition(from, to)
}

// IsTerminal reports whether a status is closed: rejected, cancelled,
// not_visit and completed route to [*] in the PRD diagram, so no move may
// ever leave them.
func IsTerminal(status VisitStatus) bool {
	switch status {
	case VisitStatusRejected, VisitStatusCancelled, VisitStatusNotVisit, VisitStatusCompleted:
		return true
	default:
		return false
	}
}
