package worker_test

import (
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/worker"
)

func workerService(visits *fakeVisitRepo, rules *fakeAutoRules, checks *fakeCheckInOutRepo) *worker.Service {
	return worker.NewService(worker.Dependencies{
		Visits:   visits,
		Rules:    rules,
		CheckIns: checks,
		Clock:    &stubClock{now: workerNow},
	})
}

func workerServiceWithNotifications(
	visits *fakeVisitRepo,
	rules *fakeAutoRules,
	checks *fakeCheckInOutRepo,
	notifications *fakeNotificationRepo,
) *worker.Service {
	return worker.NewService(worker.Dependencies{
		Visits:        visits,
		Rules:         rules,
		CheckIns:      checks,
		Notifications: notifications,
		Clock:         &stubClock{now: workerNow},
	})
}

func TestRule1_AutoCancelsRequestedAfterSevenDays(t *testing.T) {
	t.Parallel()
	// Given: a requested visit created 8 days ago (past the 7d timeout).
	old := mkVisit("visit-r1", domain.VisitStatusRequested,
		workerNow.Add(-8*24*time.Hour), workerNow, workerNow.Add(2*time.Hour))
	visits := newFakeVisitRepo(old)
	rules := &fakeAutoRules{stale: []domain.VisitRequest{old}}
	svc := workerService(visits, rules, newFakeCheckInOutRepo())
	// When: the sweep runs.
	summary := svc.Run(t.Context())
	// Then: requested -> cancelled with no human actor.
	if summary.Cancelled != 1 {
		t.Fatalf("expected 1 cancellation, got %+v", summary)
	}
	if visits.visits[old.ID].Status != domain.VisitStatusCancelled {
		t.Fatalf("expected status cancelled, got %q", visits.visits[old.ID].Status)
	}
	if len(summary.Failures) != 0 {
		t.Fatalf("expected no failures, got %+v", summary.Failures)
	}
}

func TestRule1_BoundarySevenDays(t *testing.T) {
	t.Parallel()
	// Given: the R1 cut-off derived from the frozen clock.
	r1, _, _ := worker.Thresholds(workerNow)
	cases := []struct {
		name      string
		createdAt time.Time
		want      bool
	}{
		{"exactly 7d is stale and cancelled", r1, true},
		{"7d minus 1s is not yet stale", r1.Add(time.Second), false},
		{"8d is stale", workerNow.Add(-8 * 24 * time.Hour), true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			v := mkVisit("visit-r1b", domain.VisitStatusRequested,
				tc.createdAt, workerNow, workerNow.Add(2*time.Hour))
			if got := worker.ShouldAutoCancel(v, r1); got != tc.want {
				t.Fatalf("ShouldAutoCancel(created=%v) = %v, want %v", tc.createdAt, got, tc.want)
			}
		})
	}
}

func TestRule2_NoShowAfterWindowCloses(t *testing.T) {
	t.Parallel()
	// Given: an approved visit whose window closed (end 3h ago) with no check-in.
	noShow := mkVisit("visit-r2", domain.VisitStatusApproved,
		workerNow.Add(-24*time.Hour), workerNow.Add(-5*time.Hour), workerNow.Add(-3*time.Hour))
	visits := newFakeVisitRepo(noShow)
	rules := &fakeAutoRules{noShow: []domain.VisitRequest{noShow}}
	svc := workerService(visits, rules, newFakeCheckInOutRepo())
	// When: the sweep runs.
	summary := svc.Run(t.Context())
	// Then: approved -> not_visit.
	if summary.NoShow != 1 {
		t.Fatalf("expected 1 no-show, got %+v", summary)
	}
	if visits.visits[noShow.ID].Status != domain.VisitStatusNotVisit {
		t.Fatalf("expected status not_visit, got %q", visits.visits[noShow.ID].Status)
	}
}

func TestRule2_VisitWithCheckInRowIsNotFlipped(t *testing.T) {
	t.Parallel()
	// Given: an approved visit past the window that DOES have a check-in row
	// (e.g. checked in, status flip still pending).
	v := mkVisit("visit-r2in", domain.VisitStatusApproved,
		workerNow.Add(-24*time.Hour), workerNow.Add(-5*time.Hour), workerNow.Add(-3*time.Hour))
	visits := newFakeVisitRepo(v)
	rules := &fakeAutoRules{noShow: []domain.VisitRequest{v}}
	checks := newFakeCheckInOutRepo(domain.CheckIn{
		ID:             "checkin-visit-r2in",
		VisitRequestID: v.ID,
		CheckedInAt:    workerNow.Add(-4 * time.Hour),
		CheckedInBy:    "sec-1",
	})
	svc := workerService(visits, rules, checks)
	// When: the sweep runs.
	summary := svc.Run(t.Context())
	// Then: the visit is skipped, never flipped.
	if summary.NoShow != 0 {
		t.Fatalf("expected 0 no-shows, got %+v", summary)
	}
	if visits.visits[v.ID].Status != domain.VisitStatusApproved {
		t.Fatalf("expected status to stay approved, got %q", visits.visits[v.ID].Status)
	}
	if len(visits.writes) != 0 {
		t.Fatalf("expected zero status writes, got %d", len(visits.writes))
	}
}

func TestRule2_NoShowFromOverdueRequested(t *testing.T) {
	t.Parallel()
	// Given: a requested visit whose window closed (end 3h ago), never approved.
	v := mkVisit("visit-r2req", domain.VisitStatusRequested,
		workerNow.Add(-24*time.Hour), workerNow.Add(-5*time.Hour), workerNow.Add(-3*time.Hour))
	visits := newFakeVisitRepo(v)
	rules := &fakeAutoRules{noShow: []domain.VisitRequest{v}}
	svc := workerService(visits, rules, newFakeCheckInOutRepo())
	// When: the sweep runs.
	summary := svc.Run(t.Context())
	// Then: requested -> not_visit, counted as a no-show.
	if summary.NoShow != 1 {
		t.Fatalf("expected 1 no-show, got %+v", summary)
	}
	if visits.visits[v.ID].Status != domain.VisitStatusNotVisit {
		t.Fatalf("expected status not_visit, got %q", visits.visits[v.ID].Status)
	}
}

func TestRule2_NoShowFromOverdueRescheduled(t *testing.T) {
	t.Parallel()
	// Given: a rescheduled visit whose window closed (end 3h ago), never checked in.
	v := mkVisit("visit-r2resched", domain.VisitStatusRescheduled,
		workerNow.Add(-24*time.Hour), workerNow.Add(-5*time.Hour), workerNow.Add(-3*time.Hour))
	visits := newFakeVisitRepo(v)
	rules := &fakeAutoRules{noShow: []domain.VisitRequest{v}}
	svc := workerService(visits, rules, newFakeCheckInOutRepo())
	// When: the sweep runs.
	summary := svc.Run(t.Context())
	// Then: rescheduled -> not_visit.
	if summary.NoShow != 1 {
		t.Fatalf("expected 1 no-show, got %+v", summary)
	}
	if visits.visits[v.ID].Status != domain.VisitStatusNotVisit {
		t.Fatalf("expected status not_visit, got %q", visits.visits[v.ID].Status)
	}
}

func TestRule2_BoundaryAtGraceIsInclusive(t *testing.T) {
	t.Parallel()
	// Given: the R2 cut-off (now - NoShowGrace) derived from the frozen clock.
	_, r2, _ := worker.Thresholds(workerNow)
	cases := []struct {
		name    string
		endDate time.Time
		want    bool
	}{
		{"exactly end+grace closes the window", r2, true},
		{"one second before end+grace is still open", r2.Add(time.Second), false},
		{"three hours past end is a no-show", workerNow.Add(-3 * time.Hour), true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			v := mkVisit("visit-r2b", domain.VisitStatusApproved,
				workerNow.Add(-24*time.Hour), tc.endDate.Add(-time.Hour), tc.endDate)
			if got := worker.ShouldMarkNoShow(v, r2, false); got != tc.want {
				t.Fatalf("ShouldMarkNoShow(end=%v) = %v, want %v", tc.endDate, got, tc.want)
			}
		})
	}
}

func TestRule1_StaleRequestWithOpenWindowStillCancels(t *testing.T) {
	t.Parallel()
	// Given: a requested visit created 8d ago whose window is still in the FUTURE,
	// so only R1 (not R2) may claim it.
	old := mkVisit("visit-r1open", domain.VisitStatusRequested,
		workerNow.Add(-8*24*time.Hour), workerNow.Add(3*time.Hour), workerNow.Add(5*time.Hour))
	r1, r2, _ := worker.Thresholds(workerNow)
	if !worker.ShouldAutoCancel(old, r1) {
		t.Fatal("ShouldAutoCancel = false, want true for a stale open request")
	}
	if worker.ShouldMarkNoShow(old, r2, false) {
		t.Fatal("ShouldMarkNoShow = true, want false while the window is still open")
	}
	visits := newFakeVisitRepo(old)
	rules := &fakeAutoRules{stale: []domain.VisitRequest{old}}
	svc := workerService(visits, rules, newFakeCheckInOutRepo())
	// When: the sweep runs.
	summary := svc.Run(t.Context())
	// Then: it is auto-cancelled by R1, never marked a no-show.
	if summary.Cancelled != 1 {
		t.Fatalf("expected 1 cancellation, got %+v", summary)
	}
	if summary.NoShow != 0 {
		t.Fatalf("expected 0 no-shows, got %+v", summary)
	}
	if visits.visits[old.ID].Status != domain.VisitStatusCancelled {
		t.Fatalf("expected status cancelled, got %q", visits.visits[old.ID].Status)
	}
}

func TestRules_OverdueStaleRequestBecomesNoShowNotCancelled(t *testing.T) {
	t.Parallel()
	// Given: a requested visit that is BOTH >7d old AND past its closed window,
	// so it appears on the R1 and R2 candidate lists at once.
	both := mkVisit("visit-both", domain.VisitStatusRequested,
		workerNow.Add(-8*24*time.Hour), workerNow.Add(-5*time.Hour), workerNow.Add(-3*time.Hour))
	visits := newFakeVisitRepo(both)
	rules := &fakeAutoRules{
		stale:  []domain.VisitRequest{both},
		noShow: []domain.VisitRequest{both},
	}
	svc := workerService(visits, rules, newFakeCheckInOutRepo())
	// When: the sweep runs.
	summary := svc.Run(t.Context())
	// Then: R2 claims it first (not_visit); R1 then sees the flipped row and
	// skips it, so it is never cancelled.
	if summary.NoShow != 1 {
		t.Fatalf("expected 1 no-show, got %+v", summary)
	}
	if summary.Cancelled != 0 {
		t.Fatalf("expected 0 cancellations, got %+v", summary)
	}
	if visits.visits[both.ID].Status != domain.VisitStatusNotVisit {
		t.Fatalf("expected status not_visit, got %q", visits.visits[both.ID].Status)
	}
	if summary.Skipped < 1 {
		t.Fatalf("expected R1 to skip the flipped row, got %+v", summary)
	}
}

func TestRule3_AutoCompletesAfterTwentyFourHours(t *testing.T) {
	t.Parallel()
	// Given: a visiting visit whose end was 25h ago.
	v := mkVisit("visit-r3", domain.VisitStatusVisiting,
		workerNow.Add(-48*time.Hour), workerNow.Add(-30*time.Hour), workerNow.Add(-25*time.Hour))
	visits := newFakeVisitRepo(v)
	rules := &fakeAutoRules{overstayed: []domain.VisitRequest{v}}
	svc := workerService(visits, rules, newFakeCheckInOutRepo())
	// When: the sweep runs.
	summary := svc.Run(t.Context())
	// Then: visiting -> completed.
	if summary.Completed != 1 {
		t.Fatalf("expected 1 auto-complete, got %+v", summary)
	}
	if visits.visits[v.ID].Status != domain.VisitStatusCompleted {
		t.Fatalf("expected status completed, got %q", visits.visits[v.ID].Status)
	}
}

func TestRule3_BoundaryTwentyFourHours(t *testing.T) {
	t.Parallel()
	// Given: the R3 cut-off derived from the frozen clock.
	_, _, r3 := worker.Thresholds(workerNow)
	cases := []struct {
		name    string
		endDate time.Time
		want    bool
	}{
		{"exactly 24h is completed", r3, true},
		{"24h minus 1s is not yet completed", r3.Add(time.Second), false},
		{"25h is completed", workerNow.Add(-25 * time.Hour), true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			v := mkVisit("visit-r3b", domain.VisitStatusVisiting,
				workerNow.Add(-48*time.Hour), tc.endDate.Add(-time.Hour), tc.endDate)
			if got := worker.ShouldAutoComplete(v, r3); got != tc.want {
				t.Fatalf("ShouldAutoComplete(end=%v) = %v, want %v", tc.endDate, got, tc.want)
			}
		})
	}
}

func TestRules_SkipVisitsWhoseStateChangedSinceTheSweep(t *testing.T) {
	t.Parallel()
	// Given: the sweep snapshot says requested, but the row has since been
	// approved — the worker must re-read and skip.
	snapshot := mkVisit("visit-stale", domain.VisitStatusRequested,
		workerNow.Add(-8*24*time.Hour), workerNow, workerNow.Add(2*time.Hour))
	current := snapshot
	current.Status = domain.VisitStatusApproved
	visits := newFakeVisitRepo(current)
	rules := &fakeAutoRules{stale: []domain.VisitRequest{snapshot}}
	svc := workerService(visits, rules, newFakeCheckInOutRepo())
	// When: the sweep runs.
	summary := svc.Run(t.Context())
	// Then: skipped, never flipped, no failure recorded.
	if summary.Cancelled != 0 {
		t.Fatalf("expected 0 cancellations, got %+v", summary)
	}
	if summary.Skipped != 1 {
		t.Fatalf("expected 1 skip, got %+v", summary)
	}
	if len(visits.writes) != 0 {
		t.Fatalf("expected zero status writes, got %d", len(visits.writes))
	}
	if len(summary.Failures) != 0 {
		t.Fatalf("a skip is not a failure, got %+v", summary.Failures)
	}
}

func TestRules_ContinueAfterOneVisitFails(t *testing.T) {
	t.Parallel()
	// Given: two stale requested visits; the first one's transition fails.
	bad := mkVisit("visit-bad", domain.VisitStatusRequested,
		workerNow.Add(-8*24*time.Hour), workerNow, workerNow.Add(2*time.Hour))
	good := mkVisit("visit-good", domain.VisitStatusRequested,
		workerNow.Add(-9*24*time.Hour), workerNow, workerNow.Add(2*time.Hour))
	visits := newFakeVisitRepo(bad, good)
	visits.updateErrs[bad.ID] = domain.ErrDatabase
	rules := &fakeAutoRules{stale: []domain.VisitRequest{bad, good}}
	svc := workerService(visits, rules, newFakeCheckInOutRepo())
	// When: the sweep runs.
	summary := svc.Run(t.Context())
	// Then: the bad row is collected, the good row still flips.
	if summary.Cancelled != 1 {
		t.Fatalf("expected 1 cancellation, got %+v", summary)
	}
	if len(summary.Failures) != 1 {
		t.Fatalf("expected 1 collected failure, got %+v", summary.Failures)
	}
	if visits.visits[good.ID].Status != domain.VisitStatusCancelled {
		t.Fatalf("expected good visit cancelled, got %q", visits.visits[good.ID].Status)
	}
	if visits.visits[bad.ID].Status != domain.VisitStatusRequested {
		t.Fatalf("expected bad visit to stay requested, got %q", visits.visits[bad.ID].Status)
	}
}

func TestRules_AutomaticTransitionUsesNoActor(t *testing.T) {
	t.Parallel()
	// Given: one stale requested visit.
	old := mkVisit("visit-noactor", domain.VisitStatusRequested,
		workerNow.Add(-8*24*time.Hour), workerNow, workerNow.Add(2*time.Hour))
	visits := newFakeVisitRepo(old)
	rules := &fakeAutoRules{stale: []domain.VisitRequest{old}}
	svc := workerService(visits, rules, newFakeCheckInOutRepo())
	// When: the sweep runs.
	_ = svc.Run(t.Context())
	// Then: the transition carries the empty actor id (persisted as SQL NULL).
	if len(visits.writes) != 1 {
		t.Fatalf("expected 1 status write, got %d", len(visits.writes))
	}
	if visits.writes[0].changedBy != domain.UUID("") {
		t.Fatalf("expected empty actor id, got %q", visits.writes[0].changedBy)
	}
}

func TestRule4_BoundaryReminderWindow(t *testing.T) {
	t.Parallel()
	// Given: the R4 evaluator with the production ReminderWindow (45m).
	cases := []struct {
		name   string
		status domain.VisitStatus
		start  time.Time
		want   bool
	}{
		{"approved start exactly now is not yet in window", domain.VisitStatusApproved, workerNow, false},
		{"approved start 1s ahead is in window", domain.VisitStatusApproved, workerNow.Add(time.Second), true},
		{"approved start exactly now+45m is inclusive upper edge", domain.VisitStatusApproved, workerNow.Add(worker.ReminderWindow), true},
		{"approved start 45m+1s ahead is past the window", domain.VisitStatusApproved, workerNow.Add(worker.ReminderWindow + time.Second), false},
		{"requested start in window is never reminded", domain.VisitStatusRequested, workerNow.Add(30 * time.Minute), false},
		{"visiting start in window is never reminded", domain.VisitStatusVisiting, workerNow.Add(30 * time.Minute), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			v := mkVisit("visit-r4b", tc.status,
				workerNow.Add(-time.Hour), tc.start, tc.start.Add(2*time.Hour))
			if got := worker.ShouldRemind(v, workerNow, worker.ReminderWindow); got != tc.want {
				t.Fatalf("ShouldRemind(status=%s, start=%v) = %v, want %v", tc.status, tc.start, got, tc.want)
			}
		})
	}
}

func TestRule4_EmitsReminderForApprovedVisitInWindow(t *testing.T) {
	t.Parallel()
	// Given: an approved visit starting 30m from now, listed by the sweep.
	v := mkVisit("visit-r4", domain.VisitStatusApproved,
		workerNow.Add(-time.Hour), workerNow.Add(30*time.Minute), workerNow.Add(2*time.Hour))
	visits := newFakeVisitRepo(v)
	rules := &fakeAutoRules{reminders: []domain.VisitRequest{v}}
	notif := &fakeNotificationRepo{}
	svc := workerServiceWithNotifications(visits, rules, newFakeCheckInOutRepo(), notif)
	// When: the sweep runs.
	summary := svc.Run(t.Context())
	// Then: exactly one reminder is emitted for the visit's vendor user.
	if summary.Reminded != 1 {
		t.Fatalf("expected 1 reminder, got %+v", summary)
	}
	if len(notif.writes) != 1 {
		t.Fatalf("expected 1 notification write, got %d", len(notif.writes))
	}
	if notif.writes[0].tpl == nil {
		t.Fatalf("expected a notification template, got nil")
	}
	if notif.writes[0].tpl.Type != domain.NotificationVisitReminder {
		t.Fatalf("expected template type %q, got %q", domain.NotificationVisitReminder, notif.writes[0].tpl.Type)
	}
	if len(summary.Failures) != 0 {
		t.Fatalf("expected no failures, got %+v", summary.Failures)
	}
}

func TestRule4_SkipsCandidateOutsideWindow(t *testing.T) {
	t.Parallel()
	// Given: a reminder candidate that is still requested, not approved.
	v := mkVisit("visit-r4skip", domain.VisitStatusRequested,
		workerNow.Add(-time.Hour), workerNow.Add(30*time.Minute), workerNow.Add(2*time.Hour))
	visits := newFakeVisitRepo(v)
	rules := &fakeAutoRules{reminders: []domain.VisitRequest{v}}
	notif := &fakeNotificationRepo{}
	svc := workerServiceWithNotifications(visits, rules, newFakeCheckInOutRepo(), notif)
	// When: the sweep runs.
	summary := svc.Run(t.Context())
	// Then: the candidate is skipped and nothing is written.
	if summary.Reminded != 0 {
		t.Fatalf("expected 0 reminders, got %+v", summary)
	}
	if summary.Skipped < 1 {
		t.Fatalf("expected at least 1 skip, got %+v", summary)
	}
	if len(notif.writes) != 0 {
		t.Fatalf("expected zero notification writes, got %d", len(notif.writes))
	}
}

func TestRule4_ReminderInsertFailureIsCollected(t *testing.T) {
	t.Parallel()
	// Given: an approved in-window visit whose notification insert fails.
	v := mkVisit("visit-r4fail", domain.VisitStatusApproved,
		workerNow.Add(-time.Hour), workerNow.Add(30*time.Minute), workerNow.Add(2*time.Hour))
	visits := newFakeVisitRepo(v)
	rules := &fakeAutoRules{reminders: []domain.VisitRequest{v}}
	notif := &fakeNotificationRepo{insertErr: domain.ErrDatabase}
	svc := workerServiceWithNotifications(visits, rules, newFakeCheckInOutRepo(), notif)
	// When: the sweep runs.
	summary := svc.Run(t.Context())
	// Then: the failure is collected, not aborted, and nothing is counted.
	if summary.Reminded != 0 {
		t.Fatalf("expected 0 reminders, got %+v", summary)
	}
	if len(summary.Failures) != 1 {
		t.Fatalf("expected 1 collected failure, got %+v", summary.Failures)
	}
	if summary.Failures[0].Rule != worker.RuleReminder {
		t.Fatalf("expected failure rule %q, got %q", worker.RuleReminder, summary.Failures[0].Rule)
	}
	if summary.Failures[0].VisitID != v.ID {
		t.Fatalf("expected failure visit %q, got %q", v.ID, summary.Failures[0].VisitID)
	}
}

func TestRule4_NoNotificationsPortSkipsReminders(t *testing.T) {
	t.Parallel()
	// Given: a service built WITHOUT the Notifications port, yet a visit is
	// listed as a reminder candidate.
	v := mkVisit("visit-r4nilport", domain.VisitStatusApproved,
		workerNow.Add(-time.Hour), workerNow.Add(30*time.Minute), workerNow.Add(2*time.Hour))
	visits := newFakeVisitRepo(v)
	rules := &fakeAutoRules{reminders: []domain.VisitRequest{v}}
	svc := workerService(visits, rules, newFakeCheckInOutRepo())
	// When: the sweep runs.
	summary := svc.Run(t.Context())
	// Then: the nil-port guard skips R4 entirely — no reminder, no failure.
	if summary.Reminded != 0 {
		t.Fatalf("expected 0 reminders, got %+v", summary)
	}
	if len(summary.Failures) != 0 {
		t.Fatalf("expected no failures, got %+v", summary.Failures)
	}
}
