// Package worker owns the automatic visit-status rules as PURE evaluators and
// a ticker-free sweep runner: R1 auto-cancel, R2 no-show, R3 auto-complete.
// Scheduler wiring and graceful shutdown belong to the composition root in a
// later task — this package starts no goroutine and holds no timer.
package worker

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"thc-vms/backend/internal/domain"
)

// Automatic-rule horizons. All three are absolute durations — no timezone
// conversion — measured against the injected clock.
const (
	// RequestedTimeout is the PRD "Timeout 7 Hari": a requested visit with no
	// answer for 7 days is abandoned (R1).
	RequestedTimeout = 7 * 24 * time.Hour
	// NoShowGrace is the R2 horizon: once now passes end_date+NoShowGrace the
	// check-in window has closed, so a pre-arrival visit with no check-in row
	// is a definitive no-show. It aliases the domain value so the worker and
	// the sweep repository cannot drift.
	NoShowGrace = domain.NoShowGrace
	// AutoCompleteDelay is the PRD "Auto-Complete (End Date + 24 Jam)": a
	// visit still marked visiting a full day after its scheduled end is
	// closed automatically (R3).
	AutoCompleteDelay = 24 * time.Hour
	// ReminderWindow is the R4 lead time: an approved visit whose start_date
	// falls inside (now, now+ReminderWindow] gets one reminder to its vendor user.
	ReminderWindow = 45 * time.Minute
)

// Rule identifiers used in history notes, logs and failure reports.
const (
	RuleAutoCancel   = "R1"
	RuleNoShow       = "R2"
	RuleAutoComplete = "R3"
	RuleReminder     = "R4"
)

// Automatic-transition history notes: stable, Bahasa, carrying the rule id so
// the audit trail tells a worker write apart from a manual one.
const (
	noteAutoCancel   = "Otomatis dibatalkan: pengajuan tanpa respons selama 7 hari (R1)."
	noteNoShow       = "Otomatis ditandai tidak hadir: jadwal kunjungan terlewat tanpa kedatangan (R2)."
	noteAutoComplete = "Otomatis diselesaikan: 24 jam setelah jadwal berakhir (R3)."
)

// NoActor is the empty actor id carried by automatic transitions. The
// repository persists it as SQL NULL: no human made the move.
const NoActor = domain.UUID("")

// Thresholds derives the three rule cut-offs from one instant so they live in
// exactly one place: R1 compares created_at, R2 and R3 compare end_date.
func Thresholds(now time.Time) (staleRequested, noShowApproved, overstayedVisiting time.Time) {
	return now.Add(-RequestedTimeout), now.Add(-NoShowGrace), now.Add(-AutoCompleteDelay)
}

// ShouldAutoCancel is the R1 evaluator: requested AND created at or before
// the 7-day cut-off. The comparison is inclusive: exactly 7 days old counts
// as stale.
func ShouldAutoCancel(visit domain.VisitRequest, cutoff time.Time) bool {
	return visit.Status == domain.VisitStatusRequested && !visit.CreatedAt.After(cutoff)
}

// ShouldMarkNoShow is the R2 evaluator: a pre-arrival status (requested,
// approved or rescheduled) AND the check-in window has closed (end at or
// before the cut-off) AND no check-in row exists.
func ShouldMarkNoShow(visit domain.VisitRequest, cutoff time.Time, hasCheckIn bool) bool {
	return isNoShowSource(visit.Status) && !visit.EndDate.After(cutoff) && !hasCheckIn
}

// isNoShowSource reports whether a status is one the R2 sweep may close: every
// state a visit can hold before it checks in.
func isNoShowSource(status domain.VisitStatus) bool {
	switch status {
	case domain.VisitStatusRequested, domain.VisitStatusApproved, domain.VisitStatusRescheduled:
		return true
	default:
		return false
	}
}

// ShouldAutoComplete is the R3 evaluator: visiting AND end at or before the
// 24-hour cut-off. Inclusive: exactly end+24h completes.
func ShouldAutoComplete(visit domain.VisitRequest, cutoff time.Time) bool {
	return visit.Status == domain.VisitStatusVisiting && !visit.EndDate.After(cutoff)
}

// ShouldRemind is the R4 evaluator: approved AND the scheduled start falls
// inside the half-open window (now, now+window]. A start exactly at the window
// edge still reminds; a start already in the past never does.
func ShouldRemind(visit domain.VisitRequest, now time.Time, window time.Duration) bool {
	return visit.Status == domain.VisitStatusApproved &&
		visit.StartDate.After(now) &&
		!visit.StartDate.After(now.Add(window))
}

// CheckInBatchProber is an OPTIONAL extension of domain.CheckInOutRepository:
// ports that can answer check-in existence for many visits in one round trip
// implement it, and the R2 sweep prefers it over per-visit probes. Ports that
// do not implement it keep the per-visit hasCheckIn fallback below, so
// existing adapters and fakes work unchanged.
type CheckInBatchProber interface {
	FindCheckInsByVisits(ctx context.Context, ids []domain.UUID) (map[domain.UUID]bool, error)
}

// Dependencies wires the sweep runner to its ports. Clock is mandatory in
// production (domain.SystemClock) and frozen in tests; Logger defaults to
// slog.Default when nil. Notifications is OPTIONAL: when nil the R4 reminder
// sweep is skipped (R1-R3 need only Visits/Rules/CheckIns).
type Dependencies struct {
	Visits        domain.VisitRepository
	Rules         domain.VisitAutoRuleRepository
	CheckIns      domain.CheckInOutRepository
	Notifications domain.NotificationRepository
	Clock         domain.Clock
	Logger        *slog.Logger
}

// Failure records one visit (or one sweep listing) the runner could not
// apply. Collecting instead of aborting is what keeps a single bad row from
// stalling the whole sweep.
type Failure struct {
	Rule    string
	VisitID domain.UUID
	Err     error
}

// Summary counts one sweep run: applied transitions, skips and failures.
type Summary struct {
	Cancelled int
	NoShow    int
	Completed int
	Reminded  int
	Skipped   int
	Failures  []Failure
}

// Service runs the three automatic rules against the injected ports.
type Service struct {
	visits        domain.VisitRepository
	rules         domain.VisitAutoRuleRepository
	checkIns      domain.CheckInOutRepository
	notifications domain.NotificationRepository
	clock         domain.Clock
	logger        *slog.Logger
}

// NewService builds a sweep runner, defaulting a nil clock to the wall clock
// and a nil logger to slog.Default so the runner never holds a nil.
func NewService(deps Dependencies) *Service {
	clock := deps.Clock
	if clock == nil {
		clock = domain.SystemClock{}
	}
	logger := deps.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &Service{
		visits:        deps.Visits,
		rules:         deps.Rules,
		checkIns:      deps.CheckIns,
		notifications: deps.Notifications,
		clock:         clock,
		logger:        logger,
	}
}

// Run executes all three sweeps with a single now and returns the summary. A
// failure on one visit is collected and the sweep continues; Run itself only
// fails nothing — even sweep-listing errors land in the summary — so it never
// panics and never aborts early.
func (s *Service) Run(ctx context.Context) Summary {
	var summary Summary
	if s.visits == nil || s.rules == nil || s.checkIns == nil {
		summary.Failures = append(summary.Failures, Failure{Rule: "*", Err: errors.New("worker: missing dependencies")})
		s.logger.Error("auto-rule sweep aborted: missing dependencies")
		return summary
	}
	now := s.clock.Now()
	r1, r2, r3 := Thresholds(now)
	// R2 runs before R1: an overdue request is a no-show, so the no-show sweep
	// must claim it first. R1 then re-reads a flipped row as not_visit and
	// skips it, which keeps the two sweeps disjoint even for a visit that is
	// both stale and past its window.
	s.sweepNoShow(ctx, r2, &summary)
	s.sweepRequested(ctx, r1, &summary)
	s.sweepOverstayed(ctx, r3, &summary)
	s.sweepReminders(ctx, now, &summary)
	s.logger.Info("auto-rule sweep finished",
		"cancelled", summary.Cancelled,
		"no_show", summary.NoShow,
		"completed", summary.Completed,
		"reminded", summary.Reminded,
		"skipped", summary.Skipped,
		"failures", len(summary.Failures))
	return summary
}

// sweepRequested applies R1: stale requested visits become cancelled.
func (s *Service) sweepRequested(ctx context.Context, cutoff time.Time, summary *Summary) {
	candidates, err := s.rules.FindStaleRequested(ctx, cutoff)
	if err != nil {
		summary.Failures = append(summary.Failures, Failure{Rule: RuleAutoCancel, Err: err})
		s.logger.Error("auto-rule sweep listing failed", "rule", RuleAutoCancel, "err", err)
		return
	}
	for i := range candidates {
		visit, ok := s.refresh(ctx, candidates[i].ID, summary, RuleAutoCancel)
		if !ok {
			continue
		}
		if !ShouldAutoCancel(visit, cutoff) {
			summary.Skipped++
			continue
		}
		s.apply(ctx, visit, domain.VisitStatusCancelled, noteAutoCancel, summary, RuleAutoCancel, &summary.Cancelled)
	}
}

// sweepNoShow applies R2: pre-arrival visits (requested, approved or
// rescheduled) past the closed window with no check-in row become not_visit.
func (s *Service) sweepNoShow(ctx context.Context, cutoff time.Time, summary *Summary) {
	candidates, err := s.rules.FindNoShow(ctx, cutoff)
	if err != nil {
		summary.Failures = append(summary.Failures, Failure{Rule: RuleNoShow, Err: err})
		s.logger.Error("auto-rule sweep listing failed", "rule", RuleNoShow, "err", err)
		return
	}
	present, batchOK := s.prefetchCheckIns(ctx, candidates)
	for i := range candidates {
		visit, ok := s.refresh(ctx, candidates[i].ID, summary, RuleNoShow)
		if !ok {
			continue
		}
		hasCheckIn := present[visit.ID]
		if !batchOK {
			var err error
			hasCheckIn, err = s.hasCheckIn(ctx, visit.ID)
			if err != nil {
				summary.Failures = append(summary.Failures, Failure{Rule: RuleNoShow, VisitID: visit.ID, Err: err})
				s.logger.Error("auto-rule check-in probe failed",
					"rule", RuleNoShow, "visit_id", visit.ID, "err", err)
				continue
			}
		}
		if !ShouldMarkNoShow(visit, cutoff, hasCheckIn) {
			summary.Skipped++
			continue
		}
		s.apply(ctx, visit, domain.VisitStatusNotVisit, noteNoShow, summary, RuleNoShow, &summary.NoShow)
	}
}

// sweepOverstayed applies R3: visiting visits a full day past end become
// completed. There is deliberately no OVERSTAY label: R3 is the specified
// behaviour.
func (s *Service) sweepOverstayed(ctx context.Context, cutoff time.Time, summary *Summary) {
	candidates, err := s.rules.FindOverstayedVisiting(ctx, cutoff)
	if err != nil {
		summary.Failures = append(summary.Failures, Failure{Rule: RuleAutoComplete, Err: err})
		s.logger.Error("auto-rule sweep listing failed", "rule", RuleAutoComplete, "err", err)
		return
	}
	for i := range candidates {
		visit, ok := s.refresh(ctx, candidates[i].ID, summary, RuleAutoComplete)
		if !ok {
			continue
		}
		if !ShouldAutoComplete(visit, cutoff) {
			summary.Skipped++
			continue
		}
		s.apply(ctx, visit, domain.VisitStatusCompleted, noteAutoComplete, summary, RuleAutoComplete, &summary.Completed)
	}
}

// sweepReminders applies R4: approved visits starting within ReminderWindow get
// one reminder notification to their vendor user. It mutates no visit; idempotency is
// the notification store's (user_id, type, visit_request_id) unique constraint,
// so repeated ticks, restarts and concurrent workers never double-post.
func (s *Service) sweepReminders(ctx context.Context, now time.Time, summary *Summary) {
	if s.notifications == nil {
		return
	}
	windowEnd := now.Add(ReminderWindow)
	candidates, err := s.rules.FindUpcomingApproved(ctx, now, windowEnd)
	if err != nil {
		summary.Failures = append(summary.Failures, Failure{Rule: RuleReminder, Err: err})
		s.logger.Error("auto-rule sweep listing failed", "rule", RuleReminder, "err", err)
		return
	}
	for i := range candidates {
		visit, ok := s.refresh(ctx, candidates[i].ID, summary, RuleReminder)
		if !ok {
			continue
		}
		if !ShouldRemind(visit, now, ReminderWindow) {
			summary.Skipped++
			continue
		}
		if err := s.notifications.InsertForVisit(ctx, visit, domain.ReminderNotification(visit.VisitID)); err != nil {
			summary.Failures = append(summary.Failures, Failure{Rule: RuleReminder, VisitID: visit.ID, Err: err})
			s.logger.Error("auto-rule reminder emit failed", "rule", RuleReminder, "visit_id", visit.ID, "err", err)
			continue
		}
		summary.Reminded++
		s.logger.Info("auto-rule reminder emitted", "rule", RuleReminder, "visit_id", visit.ID)
	}
}

// refresh re-reads the visit so the runner never flips a row whose state
// changed since the sweep listing. A missing row is a collected failure, not
// a panic and not an abort.
func (s *Service) refresh(ctx context.Context, id domain.UUID, summary *Summary, rule string) (domain.VisitRequest, bool) {
	visit, err := s.visits.FindByID(ctx, id)
	if err != nil {
		summary.Failures = append(summary.Failures, Failure{Rule: rule, VisitID: id, Err: err})
		s.logger.Error("auto-rule refresh failed", "rule", rule, "visit_id", id, "err", err)
		return domain.VisitRequest{}, false
	}
	return visit, true
}

// prefetchCheckIns resolves check-in existence for the whole R2 candidate
// set in ONE round trip when the port implements CheckInBatchProber. The
// second return is false when the port has no batch seam (or the batch
// failed), and the caller falls back to per-visit hasCheckIn probes: a batch
// failure degrades to the old path instead of aborting the sweep.
func (s *Service) prefetchCheckIns(
	ctx context.Context,
	candidates []domain.VisitRequest,
) (map[domain.UUID]bool, bool) {
	if len(candidates) == 0 {
		return nil, false
	}
	prober, ok := s.checkIns.(CheckInBatchProber)
	if !ok {
		return nil, false
	}
	ids := make([]domain.UUID, 0, len(candidates))
	for i := range candidates {
		ids = append(ids, candidates[i].ID)
	}
	present, err := prober.FindCheckInsByVisits(ctx, ids)
	if err != nil {
		s.logger.Error("auto-rule batched check-in probe failed, falling back to single probes",
			"rule", RuleNoShow, "err", err)
		return nil, false
	}
	return present, true
}

// hasCheckIn reports whether a check-in row exists. A missing row (ErrNotFound)
// means nobody arrived; any other error is surfaced to be collected.
func (s *Service) hasCheckIn(ctx context.Context, visitID domain.UUID) (bool, error) {
	_, err := s.checkIns.FindCheckInByVisit(ctx, visitID)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, domain.ErrNotFound) {
		return false, nil
	}
	return false, err
}

// apply asserts the transition still holds, then persists it with the empty
// actor id. Transition or persistence failures are collected and counted;
// each applied move is logged at Info and bumps its rule counter.
func (s *Service) apply(ctx context.Context, visit domain.VisitRequest, to domain.VisitStatus, notes string, summary *Summary, rule string, counter *int) {
	if err := domain.CanTransition(visit.Status, to); err != nil {
		summary.Failures = append(summary.Failures, Failure{Rule: rule, VisitID: visit.ID, Err: err})
		s.logger.Error("auto-rule transition refused",
			"rule", rule, "visit_id", visit.ID,
			"from", string(visit.Status), "to", string(to), "err", err)
		return
	}
	if err := s.visits.UpdateStatus(ctx, visit.ID, to, NoActor, notes); err != nil {
		summary.Failures = append(summary.Failures, Failure{Rule: rule, VisitID: visit.ID, Err: err})
		s.logger.Error("auto-rule transition failed",
			"rule", rule, "visit_id", visit.ID,
			"from", string(visit.Status), "to", string(to), "err", err)
		return
	}
	*counter++
	s.logger.Info("auto-rule transition applied",
		"rule", rule, "visit_id", visit.ID,
		"from", string(visit.Status), "to", string(to))
}
