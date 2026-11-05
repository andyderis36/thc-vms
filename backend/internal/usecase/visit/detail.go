package visit

import (
	"context"
	"errors"
	"log/slog"
	"strings"

	"thc-vms/backend/internal/domain"
)

// GetVisit loads one visit by UUID or VST- business code and applies read
// scope: branch isolation for admin/security, ownership for vendor, global
// for superadmin. There is no date filter: a guard opens any visit in its
// own branch (approved future visits, rescheduled, completed history),
// matching what ListVisits already serves to the same caller.
func (s *Service) GetVisit(ctx context.Context, actor Actor, key string) (domain.VisitRequest, error) {
	var (
		visit domain.VisitRequest
		err   error
	)
	if strings.HasPrefix(key, "VST-") {
		visit, err = s.visits.FindByVisitCode(ctx, key)
	} else {
		visit, err = s.visits.FindByID(ctx, domain.UUID(key))
	}
	if err != nil {
		return domain.VisitRequest{}, err
	}
	if err := authorizeVisitRead(actor, visit); err != nil {
		return domain.VisitRequest{}, err
	}
	// File links are exchanged last: withFileLinks only runs on an
	// already-authorized visit, so the scoped read above is the authz and no
	// new scope check is introduced here.
	return s.withFileLinks(ctx, s.withStatusNote(ctx, s.withGateTimes(ctx, visit))), nil
}

// withGateTimes enriches one ALREADY-AUTHORIZED visit with its gate timestamps
// for the GET /visits/{id} response (QA GATE-01/02/09). It runs only here, not
// in ListVisits: a 100-row page would otherwise pay up to 200 extra point
// lookups (N+1), while a single GET pays at most two indexed lookups on the
// UNIQUE visit_request_id columns. A missing gate row (ErrNotFound) means "not
// yet checked in/out" and leaves the pointers nil; any other storage error is
// swallowed the same way so a gate-table outage never turns a readable visit
// into a 500 — the visit row itself is the source of truth for the read scope,
// the gate times are best-effort display data. Non-NotFound failures are
// logged once per lookup (visit id + op + err) so a silent gate-table outage
// stays diagnosable without changing the response contract.
func (s *Service) withGateTimes(ctx context.Context, visit domain.VisitRequest) domain.VisitRequest {
	if s.checkIns == nil {
		return visit
	}
	if checkIn, err := s.checkIns.FindCheckInByVisit(ctx, visit.ID); err == nil {
		at := checkIn.CheckedInAt
		by := checkIn.CheckedInBy
		visit.CheckInAt = &at
		visit.CheckedInBy = &by
	} else if !errors.Is(err, domain.ErrNotFound) {
		slog.Warn("visit: gate check-in lookup failed", "visit_id", string(visit.ID), "op", "FindCheckInByVisit", "error", err)
	}
	if checkOut, err := s.checkIns.FindCheckOutByVisit(ctx, visit.ID); err == nil {
		at := checkOut.CheckedOutAt
		visit.CheckOutAt = &at
	} else if !errors.Is(err, domain.ErrNotFound) {
		slog.Warn("visit: gate check-out lookup failed", "visit_id", string(visit.ID), "op", "FindCheckOutByVisit", "error", err)
	}
	return visit
}

// withStatusNote attaches the note of the current status transition (the
// rejection reason, cancellation reason, or reschedule reason) loaded from
// status_history. Best-effort: a missing history or missing note leaves
// StatusNote nil; a storage error is swallowed and logged so a history-table
// outage never turns a readable visit into a 500.
func (s *Service) withStatusNote(ctx context.Context, visit domain.VisitRequest) domain.VisitRequest {
	if s.visits == nil {
		return visit
	}
	note, err := s.visits.GetLatestStatusNote(ctx, visit.ID)
	if err != nil {
		slog.Warn("visit: status note lookup failed", "visit_id", string(visit.ID), "error", err)
		return visit
	}
	visit.StatusNote = note
	return visit
}
