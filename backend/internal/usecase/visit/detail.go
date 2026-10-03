package visit

import (
	"context"
	"strings"
	"time"

	"thc-vms/backend/internal/domain"
)

// facilityIANAZone maps the facility timezone vocabulary to IANA names so the
// visit day is evaluated where the facility stands, not where the server runs.
func facilityIANAZone(tz domain.Timezone) (name string, fallbackOffset int) {
	switch tz {
	case domain.TimezoneWITA:
		return "Asia/Makassar", 8 * 3600
	case domain.TimezoneWIT:
		return "Asia/Jayapura", 9 * 3600
	case domain.TimezoneWIB:
		return "Asia/Jakarta", 7 * 3600
	default:
		return "Asia/Jakarta", 7 * 3600
	}
}

// facilityLocation resolves the facility clock: the IANA zone when the host
// ships tzdata, otherwise a fixed WIB/WITA/WIT offset so Windows hosts without
// a zoneinfo database still evaluate the visit day correctly.
func facilityLocation(tz domain.Timezone) *time.Location {
	name, offset := facilityIANAZone(tz)
	if loc, err := time.LoadLocation(name); err == nil {
		return loc
	}
	return time.FixedZone(string(tz), offset)
}

// overlapsVisitDay reports whether the visit window touches the facility-local
// calendar day holding now. Instant comparison is timezone-independent; only
// the day bounds come from the facility zone.
func overlapsVisitDay(now time.Time, visit domain.VisitRequest, loc *time.Location) bool {
	local := now.In(loc)
	dayStart := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, loc)
	dayEnd := dayStart.Add(24 * time.Hour)
	return visit.StartDate.Before(dayEnd) && !visit.EndDate.Before(dayStart)
}

// GetVisit loads one visit by UUID or VST- business code and applies read
// scope: branch isolation for admin/security, ownership for vendor, and the
// TODAY-only restriction for security evaluated in the facility timezone with
// the injected clock (never time.Now).
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
	switch actor.Role {
	case domain.RoleSuperAdmin:
	case domain.RoleAdmin, domain.RoleSecurity:
		if err := actor.requireBranch(visit.LocationID); err != nil {
			return domain.VisitRequest{}, err
		}
	case domain.RoleVendor:
		if visit.PICUserID != actor.ID {
			return domain.VisitRequest{}, domain.NotFoundEntity("Kunjungan")
		}
	default:
		return domain.VisitRequest{}, domain.ForbiddenBranch()
	}
	if actor.IsSecurity() {
		loc, err := s.master.FindLocationByID(ctx, visit.LocationID)
		if err != nil {
			return domain.VisitRequest{}, err
		}
		if !overlapsVisitDay(s.clock.Now(), visit, facilityLocation(loc.Timezone)) {
			return domain.VisitRequest{}, domain.NotFoundEntity("Kunjungan")
		}
	}
	// File links are exchanged last: withFileLinks only runs on an
	// already-authorized visit, so the scoped read above is the authz and no
	// new scope check is introduced here.
	return s.withFileLinks(ctx, s.withGateTimes(ctx, visit)), nil
}

// withGateTimes enriches one ALREADY-AUTHORIZED visit with its gate timestamps
// for the GET /visits/{id} response (QA GATE-01/02/09). It runs only here, not
// in ListVisits: a 100-row page would otherwise pay up to 200 extra point
// lookups (N+1), while a single GET pays at most two indexed lookups on the
// UNIQUE visit_request_id columns. A missing gate row (ErrNotFound) means "not
// yet checked in/out" and leaves the pointers nil; any other storage error is
// swallowed the same way so a gate-table outage never turns a readable visit
// into a 500 — the visit row itself is the source of truth for the read scope,
// the gate times are best-effort display data.
func (s *Service) withGateTimes(ctx context.Context, visit domain.VisitRequest) domain.VisitRequest {
	if s.checkIns == nil {
		return visit
	}
	if checkIn, err := s.checkIns.FindCheckInByVisit(ctx, visit.ID); err == nil {
		at := checkIn.CheckedInAt
		by := checkIn.CheckedInBy
		visit.CheckInAt = &at
		visit.CheckedInBy = &by
	}
	if checkOut, err := s.checkIns.FindCheckOutByVisit(ctx, visit.ID); err == nil {
		at := checkOut.CheckedOutAt
		visit.CheckOutAt = &at
	}
	return visit
}
