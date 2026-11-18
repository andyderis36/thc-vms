package domain_test

import (
	"testing"

	"thc-vms/backend/internal/domain"
)

func TestResolveGateTransition_AllowsTheThreeMultiEntryMoves(t *testing.T) {
	allowed := []struct {
		name    string
		current domain.VisitStatus
		action  domain.GateAction
		next    domain.VisitStatus
	}{
		{"first check-in", domain.VisitStatusApproved, domain.GateActionCheckIn, domain.VisitStatusVisiting},
		{"check-out to offsite", domain.VisitStatusVisiting, domain.GateActionCheckOut, domain.VisitStatusOffsite},
		{"re-check-in from offsite", domain.VisitStatusOffsite, domain.GateActionCheckIn, domain.VisitStatusVisiting},
	}
	for _, tc := range allowed {
		t.Run(tc.name, func(t *testing.T) {
			next, ok := domain.ResolveGateTransition(tc.current, tc.action)
			if !ok {
				t.Fatalf("ResolveGateTransition(%q, %q) = rejected, want %q", tc.current, tc.action, tc.next)
			}
			if next != tc.next {
				t.Fatalf("ResolveGateTransition(%q, %q) = %q, want %q", tc.current, tc.action, next, tc.next)
			}
		})
	}
}

func TestResolveGateTransition_RejectsEverythingElse(t *testing.T) {
	rejected := []struct {
		name    string
		current domain.VisitStatus
		action  domain.GateAction
	}{
		{"check-out without check-in", domain.VisitStatusApproved, domain.GateActionCheckOut},
		{"double check-in without check-out", domain.VisitStatusVisiting, domain.GateActionCheckIn},
		{"double check-out without re-check-in", domain.VisitStatusOffsite, domain.GateActionCheckOut},
		{"gate move on requested", domain.VisitStatusRequested, domain.GateActionCheckIn},
		{"gate move on requested checkout", domain.VisitStatusRequested, domain.GateActionCheckOut},
		{"gate move on rescheduled", domain.VisitStatusRescheduled, domain.GateActionCheckIn},
		{"gate move on completed", domain.VisitStatusCompleted, domain.GateActionCheckIn},
		{"gate move on completed checkout", domain.VisitStatusCompleted, domain.GateActionCheckOut},
		{"gate move on cancelled", domain.VisitStatusCancelled, domain.GateActionCheckIn},
		{"gate move on rejected", domain.VisitStatusRejected, domain.GateActionCheckOut},
		{"gate move on not_visit", domain.VisitStatusNotVisit, domain.GateActionCheckIn},
		{"unknown action on approved", domain.VisitStatusApproved, domain.GateAction("close")},
		{"unknown action on visiting", domain.VisitStatusVisiting, domain.GateAction("")},
		{"empty status", domain.VisitStatusNone, domain.GateActionCheckIn},
	}
	for _, tc := range rejected {
		t.Run(tc.name, func(t *testing.T) {
			if next, ok := domain.ResolveGateTransition(tc.current, tc.action); ok {
				t.Fatalf("ResolveGateTransition(%q, %q) = (%q, true), want rejected", tc.current, tc.action, next)
			}
		})
	}
}
