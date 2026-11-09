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
	return s.withFileLinks(ctx, s.withWorkPhotos(ctx, s.withStatusHistory(ctx, s.withGateTimes(ctx, visit)))), nil
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
		visit.CheckedInByName = checkIn.CheckedInByName
	} else if !errors.Is(err, domain.ErrNotFound) {
		slog.Warn("visit: gate check-in lookup failed", "visit_id", string(visit.ID), "op", "FindCheckInByVisit", "error", err)
	}
	if checkOut, err := s.checkIns.FindCheckOutByVisit(ctx, visit.ID); err == nil {
		at := checkOut.CheckedOutAt
		by := checkOut.CheckedOutBy
		visit.CheckOutAt = &at
		visit.CheckedOutBy = &by
		visit.CheckedOutByName = checkOut.CheckedOutByName
	} else if !errors.Is(err, domain.ErrNotFound) {
		slog.Warn("visit: gate check-out lookup failed", "visit_id", string(visit.ID), "op", "FindCheckOutByVisit", "error", err)
	}
	return visit
}

// withWorkPhotos enriches one ALREADY-AUTHORIZED visit with its before/after
// work proofs for the GET /visits/{id} work_photos member. It runs only on
// the single-GET path, not in ListVisits: the proofs need one extra indexed
// lookup the list page must not pay per row. Each stored URL is exchanged
// for a short-lived presigned link through presignStoredURL, so a storage
// outage blanks that slot instead of leaking the raw private-bucket address.
// Best-effort like withGateTimes: a lookup failure leaves the pair nil and
// is logged once, so a work-photo-table outage never turns a readable visit
// into a 500.
func (s *Service) withWorkPhotos(ctx context.Context, visit domain.VisitRequest) domain.VisitRequest {
	if s.visits == nil {
		return visit
	}
	photos, err := s.visits.ListWorkPhotos(ctx, visit.ID)
	if err != nil {
		slog.Warn("visit: work photo lookup failed", "visit_id", string(visit.ID), "error", err)
		return visit
	}
	set := &domain.WorkPhotoSet{}
	for i := range photos {
		signed := s.presignStoredURL(ctx, &photos[i].URL)
		if signed == nil {
			photos[i].URL = ""
		} else {
			photos[i].URL = *signed
		}
		switch photos[i].Kind {
		case domain.WorkPhotoBefore:
			proof := photos[i]
			set.Before = &proof
		case domain.WorkPhotoAfter:
			proof := photos[i]
			set.After = &proof
		}
	}
	visit.WorkPhotos = set
	return visit
}

// withStatusHistory attaches the actor-resolved status trail (and, from its
// newest row, the note of the current status transition: the rejection,
// cancellation, or reschedule reason) to one ALREADY-AUTHORIZED visit. It runs
// only on the single-GET path, not in ListVisits. Best-effort like
// withGateTimes: a storage error is swallowed and logged once, so a
// history-table outage never turns a readable visit into a 500 — the client
// then renders its derived timeline steps from the fallback props alone.
func (s *Service) withStatusHistory(ctx context.Context, visit domain.VisitRequest) domain.VisitRequest {
	if s.visits == nil {
		return visit
	}
	events, err := s.visits.ListStatusHistory(ctx, visit.ID)
	if err != nil {
		slog.Warn("visit: status history lookup failed", "visit_id", string(visit.ID), "error", err)
		return visit
	}
	visit.History = events
	if last := len(events) - 1; last >= 0 {
		visit.StatusNote = events[last].Notes
	}
	return visit
}
