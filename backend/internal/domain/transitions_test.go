package domain_test

import (
	"errors"
	"testing"

	"thc-vms/backend/internal/domain"
)

// allowedTransitions enumerates the 14 transitions the PRD state machine
// (docs/0. PRD section 5) permits. Anything not listed here is rejected by
// CanTransition - including the transitions that are forbidden only by
// omission in the diagram and are therefore the classic implementation bug.
//
// A schedule change may be moved again without re-approval
// (rescheduled->rescheduled), and an unapproved request may be rescheduled
// before it is approved (requested->rescheduled), but check-in still needs
// re-approval first: rescheduled->visiting stays forbidden by omission.
var allowedTransitions = []struct {
	name string
	from domain.VisitStatus
	to   domain.VisitStatus
}{
	{"submitted by vendor or Admin", "", domain.VisitStatusRequested},
	{"approved by branch admin", domain.VisitStatusRequested, domain.VisitStatusApproved},
	{"rejected by branch admin", domain.VisitStatusRequested, domain.VisitStatusRejected},
	{"cancelled by vendor or admin", domain.VisitStatusRequested, domain.VisitStatusCancelled},
	{"checked in at the gate", domain.VisitStatusApproved, domain.VisitStatusVisiting},
	{"new schedule proposed", domain.VisitStatusApproved, domain.VisitStatusRescheduled},
	{"requested visit rescheduled before approval", domain.VisitStatusRequested, domain.VisitStatusRescheduled},
	{"cancelled before day H", domain.VisitStatusApproved, domain.VisitStatusCancelled},
	{"no show after day H", domain.VisitStatusApproved, domain.VisitStatusNotVisit},
	{"new schedule approved", domain.VisitStatusRescheduled, domain.VisitStatusApproved},
	{"schedule moved again without re-approval", domain.VisitStatusRescheduled, domain.VisitStatusRescheduled},
	{"reschedule withdrawn", domain.VisitStatusRescheduled, domain.VisitStatusCancelled},
	{"checked out at the gate", domain.VisitStatusVisiting, domain.VisitStatusCompleted},
	{"auto completed after end date +24h", domain.VisitStatusVisiting, domain.VisitStatusCompleted},
}

// forbiddenTransitions enumerates the moves that MUST be rejected. The first
// two are the ones the diagram omits; the rest are explicit PRD violations.
var forbiddenTransitions = []struct {
	name string
	from domain.VisitStatus
	to   domain.VisitStatus
}{
	{"reschedule skips approval before check-in", domain.VisitStatusRescheduled, domain.VisitStatusVisiting},
	{"reject is illegal from approved", domain.VisitStatusApproved, domain.VisitStatusRejected},
	{"cannot leave rejected", domain.VisitStatusRejected, domain.VisitStatusApproved},
	{"cannot leave cancelled", domain.VisitStatusCancelled, domain.VisitStatusApproved},
	{"cannot leave not_visit", domain.VisitStatusNotVisit, domain.VisitStatusApproved},
	{"cannot leave completed", domain.VisitStatusCompleted, domain.VisitStatusVisiting},
	{"cannot cancel an on-site visit", domain.VisitStatusVisiting, domain.VisitStatusCancelled},
	{"cannot mark an on-site visit as no show", domain.VisitStatusVisiting, domain.VisitStatusNotVisit},
	{"cannot re-approve an on-site visit", domain.VisitStatusVisiting, domain.VisitStatusApproved},
	{"cannot skip the requested state", "", domain.VisitStatusApproved},
	{"cannot go straight to visiting", domain.VisitStatusRequested, domain.VisitStatusVisiting},
	{"cannot reschedule an on-site visit", domain.VisitStatusVisiting, domain.VisitStatusRescheduled},
	{"cannot reschedule a completed visit", domain.VisitStatusCompleted, domain.VisitStatusRescheduled},
	{"cannot reschedule a cancelled visit", domain.VisitStatusCancelled, domain.VisitStatusRescheduled},
	{"cannot reschedule a rejected visit", domain.VisitStatusRejected, domain.VisitStatusRescheduled},
	{"cannot reschedule a no-show visit", domain.VisitStatusNotVisit, domain.VisitStatusRescheduled},
}

func TestCanTransition_AllowsTheFourteenPRDTransitions(t *testing.T) {
	// Given: every transition the PRD state machine declares.
	// When:  each one is submitted to the rule set.
	// Then:   each one is accepted with a nil error.
	for _, tc := range allowedTransitions {
		t.Run(tc.name, func(t *testing.T) {
			if err := domain.CanTransition(tc.from, tc.to); err != nil {
				t.Fatalf("CanTransition(%q, %q) = %v, want nil", tc.from, tc.to, err)
			}
		})
	}
}

func TestCanTransition_RejectsEverythingElse(t *testing.T) {
	// Given: moves the PRD forbids, including the forbidden-by-omission ones.
	// When:  each one is submitted to the rule set.
	// Then:   each one is refused with an error wrapping ErrInvalidTransition.
	for _, tc := range forbiddenTransitions {
		t.Run(tc.name, func(t *testing.T) {
			err := domain.CanTransition(tc.from, tc.to)
			if err == nil {
				t.Fatalf("CanTransition(%q, %q) = nil, want ErrInvalidTransition", tc.from, tc.to)
			}
			if !errors.Is(err, domain.ErrInvalidTransition) {
				t.Fatalf("CanTransition(%q, %q) = %v, want an error wrapping ErrInvalidTransition", tc.from, tc.to, err)
			}
		})
	}
}

func TestCanTransition_RejectsUnknownStatusValues(t *testing.T) {
	// Given: a status string that is not part of the 8-value vocabulary.
	// When:  it is used as a transition endpoint.
	// Then:   the move is refused instead of being treated as a valid state.
	for _, tc := range []struct {
		name string
		from domain.VisitStatus
		to   domain.VisitStatus
	}{
		{"unknown target", domain.VisitStatusApproved, domain.VisitStatus("archived")},
		{"unknown origin", domain.VisitStatus("archived"), domain.VisitStatusApproved},
		{"self loop on requested", domain.VisitStatusRequested, domain.VisitStatusRequested},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := domain.CanTransition(tc.from, tc.to); !errors.Is(err, domain.ErrInvalidTransition) {
				t.Fatalf("CanTransition(%q, %q) = %v, want ErrInvalidTransition", tc.from, tc.to, err)
			}
		})
	}
}

func TestTransitionRuleSet_HasExactlyFourteenEntries(t *testing.T) {
	// Given: the PRD declares 14 legal moves.
	// When:  the whole rule set is counted.
	// Then:   there are exactly 14, so no extra path sneaks in.
	if got := len(domain.AllTransitions()); got != 14 {
		t.Fatalf("len(AllTransitions()) = %d, want 14", got)
	}
}

func TestTransitionsFrom_VisitingToCompletedHasTwoCauses(t *testing.T) {
	// Given: the PRD marks visiting->completed twice: manual check-out and
	//        the auto-complete worker (end_date + 24h).
	// When:  the outgoing rule set of `visiting` is read.
	// Then:   completed is reachable through both triggers.
	triggers := domain.TransitionTriggersFrom(domain.VisitStatusVisiting, domain.VisitStatusCompleted)
	want := map[domain.TransitionTrigger]bool{
		domain.TriggerCheckOut:     false,
		domain.TriggerAutoComplete: false,
	}
	for _, trigger := range triggers {
		if _, known := want[trigger]; !known {
			t.Fatalf("unexpected trigger %q for visiting->completed", trigger)
		}
		want[trigger] = true
	}
	for trigger, seen := range want {
		if !seen {
			t.Errorf("visiting->completed is missing trigger %q", trigger)
		}
	}
}

func TestIsTerminal_OnlyTheFourClosedStatusesAreTerminal(t *testing.T) {
	// Given: rejected, cancelled, not_visit and completed are the closed
	//        states the diagram routes to [*].
	// When:  every one of the 8 statuses is classified.
	// Then:   exactly those 4 report terminal, and none of them may transition.
	terminal := map[domain.VisitStatus]bool{
		domain.VisitStatusRejected:  true,
		domain.VisitStatusCancelled: true,
		domain.VisitStatusNotVisit:  true,
		domain.VisitStatusCompleted: true,
	}
	all := domain.AllVisitStatuses()
	if len(all) != 8 {
		t.Fatalf("len(AllVisitStatuses()) = %d, want 8", len(all))
	}
	for _, status := range all {
		want := terminal[status]
		if got := domain.IsTerminal(status); got != want {
			t.Errorf("IsTerminal(%q) = %v, want %v", status, got, want)
		}
		if !want {
			continue
		}
		for _, target := range all {
			if err := domain.CanTransition(status, target); !errors.Is(err, domain.ErrInvalidTransition) {
				t.Errorf("CanTransition(%q, %q) = %v, want ErrInvalidTransition", status, target, err)
			}
		}
	}
}

func TestParseVisitStatus(t *testing.T) {
	// Given: the exact 8-value vocabulary fixed for the MVP.
	// When:  each value is parsed back from its stored string form.
	// Then:   it round-trips to the matching constant.
	want := map[string]domain.VisitStatus{
		"requested":   domain.VisitStatusRequested,
		"approved":    domain.VisitStatusApproved,
		"visiting":    domain.VisitStatusVisiting,
		"completed":   domain.VisitStatusCompleted,
		"not_visit":   domain.VisitStatusNotVisit,
		"rejected":    domain.VisitStatusRejected,
		"cancelled":   domain.VisitStatusCancelled,
		"rescheduled": domain.VisitStatusRescheduled,
	}
	for raw, expected := range want {
		got, err := domain.ParseVisitStatus(raw)
		if err != nil {
			t.Errorf("ParseVisitStatus(%q) unexpected error: %v", raw, err)
			continue
		}
		if got != expected {
			t.Errorf("ParseVisitStatus(%q) = %q, want %q", raw, got, expected)
		}
		if string(expected) != raw {
			t.Errorf("VisitStatus constant %q does not match DB value %q", expected, raw)
		}
	}
	if _, err := domain.ParseVisitStatus("archived"); !errors.Is(err, domain.ErrUnknownVisitStatus) {
		t.Errorf("ParseVisitStatus(%q) = %v, want ErrUnknownVisitStatus", "archived", err)
	}
}
