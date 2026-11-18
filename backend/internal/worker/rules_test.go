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

func TestRule1_AutoCancelsRequestedOnceWindowStarted(t *testing.T) {
	t.Parallel()
	// Given: a freshly filed requested visit whose window already started
	// (created an hour ago, start an hour ago) and never got approved.
	old := mkVisit("visit-r1", domain.VisitStatusRequested,
		workerNow.Add(-time.Hour), workerNow.Add(-time.Hour), workerNow.Add(2*time.Hour))
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

func TestRule1_BoundaryWindowStart(t *testing.T) {
	t.Parallel()
	// Given: the R1 instant (the frozen clock itself).
	cases := []struct {
		name  string
		start time.Time
		want  bool
	}{
		{"start exactly now counts as started", workerNow, true},
		{"start one second ago counts as started", workerNow.Add(-time.Second), true},
		{"start one second ahead has not started", workerNow.Add(time.Second), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			v := mkVisit("visit-r1b", domain.VisitStatusRequested,
				workerNow.Add(-time.Hour), tc.start, tc.start.Add(2*time.Hour))
			if got := worker.ShouldAutoCancel(v, workerNow); got != tc.want {
				t.Fatalf("ShouldAutoCancel(start=%v) = %v, want %v", tc.start, got, tc.want)
			}
		})
	}
}

func TestRule2_NoShowAfterWindowCloses(t *testing.T) {
	t.Parallel()
	// Given: an approved permit whose end datetime has passed with no entry.
	noShow := mkVisit("visit-r2", domain.VisitStatusApproved,
		workerNow.Add(-24*time.Hour), workerNow.Add(-5*time.Hour), workerNow.Add(-3*time.Hour))
	visits := newFakeVisitRepo(noShow)
	rules := &fakeAutoRules{noShow: []domain.VisitRequest{noShow}}
	svc := workerService(visits, rules, newFakeCheckInOutRepo())
	// When: the sweep runs.
	summary := svc.Run(t.Context())
	// Then: approved -> cancelled (the visit_auto_cancelled notice), not not_visit.
	if summary.NoShow != 1 {
		t.Fatalf("expected 1 no-show, got %+v", summary)
	}
	if visits.visits[noShow.ID].Status != domain.VisitStatusCancelled {
		t.Fatalf("expected status cancelled, got %q", visits.visits[noShow.ID].Status)
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

func TestRule2_OverdueRequestedIsR2Source(t *testing.T) {
	t.Parallel()
	// Given: a requested visit that ended three hours ago — one hour past R1's
	// end_date > now()-2h guard, so R1 can no longer list it. R2 must claim it
	// instead, otherwise the row is swept by no rule at all.
	v := mkVisit("visit-r2req", domain.VisitStatusRequested,
		workerNow.Add(-24*time.Hour), workerNow.Add(-5*time.Hour), workerNow.Add(-3*time.Hour))
	visits := newFakeVisitRepo(v)
	rules := &fakeAutoRules{noShow: []domain.VisitRequest{v}}
	svc := workerService(visits, rules, newFakeCheckInOutRepo())
	// When: the sweep runs.
	summary := svc.Run(t.Context())
	// Then: R2 cancels it (zero entries) with the R2 note.
	if summary.NoShow != 1 {
		t.Fatalf("expected 1 no-show, got %+v", summary)
	}
	if visits.visits[v.ID].Status != domain.VisitStatusCancelled {
		t.Fatalf("expected status cancelled, got %q", visits.visits[v.ID].Status)
	}
	if len(visits.writes) != 1 || visits.writes[0].notes != "Otomatis dibatalkan: tidak ada check-in hingga akhir jadwal (R2)." {
		t.Fatalf("writes = %+v, want one R2 auto-cancel note", visits.writes)
	}
}

func TestRule2_RescheduledIsR2Source(t *testing.T) {
	t.Parallel()
	// Given: a rescheduled visit whose end datetime has passed with no entry.
	// Rescheduling without a re-approval must not leave the permit open forever.
	v := mkVisit("visit-r2resched", domain.VisitStatusRescheduled,
		workerNow.Add(-24*time.Hour), workerNow.Add(-5*time.Hour), workerNow.Add(-3*time.Hour))
	visits := newFakeVisitRepo(v)
	rules := &fakeAutoRules{noShow: []domain.VisitRequest{v}}
	svc := workerService(visits, rules, newFakeCheckInOutRepo())
	// When: the sweep runs.
	summary := svc.Run(t.Context())
	// Then: R2 cancels it with the R2 note.
	if summary.NoShow != 1 {
		t.Fatalf("expected 1 no-show, got %+v", summary)
	}
	if visits.visits[v.ID].Status != domain.VisitStatusCancelled {
		t.Fatalf("expected status cancelled, got %q", visits.visits[v.ID].Status)
	}
	if len(visits.writes) != 1 || visits.writes[0].notes != "Otomatis dibatalkan: tidak ada check-in hingga akhir jadwal (R2)." {
		t.Fatalf("writes = %+v, want one R2 auto-cancel note", visits.writes)
	}
}

// TestRule2_RequestedGuardBoundary pins the R1/R2 split on end_date for the
// requested status: R1's guard owns (now-2h, now], R2 owns everything at or
// before now-2h. Rescheduled and approved are R2's from the exact end instant.
func TestRule2_RequestedGuardBoundary(t *testing.T) {
	t.Parallel()
	r2, _ := worker.Thresholds(workerNow)
	guardEdge := r2.Add(-domain.NoShowGrace)
	cases := []struct {
		name    string
		status  domain.VisitStatus
		endDate time.Time
		want    bool
	}{
		{"requested at the guard edge leaves R1", domain.VisitStatusRequested, guardEdge, true},
		{"requested one second inside the guard stays R1's", domain.VisitStatusRequested, guardEdge.Add(time.Second), false},
		{"requested one second past the guard is R2's", domain.VisitStatusRequested, guardEdge.Add(-time.Second), true},
		{"rescheduled at the exact end is R2's", domain.VisitStatusRescheduled, r2, true},
		{"rescheduled one second before end is not yet R2's", domain.VisitStatusRescheduled, r2.Add(time.Second), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			v := mkVisit("visit-r2guard", tc.status,
				workerNow.Add(-24*time.Hour), tc.endDate.Add(-time.Hour), tc.endDate)
			if got := worker.ShouldMarkNoShow(v, r2, false); got != tc.want {
				t.Fatalf("ShouldMarkNoShow(status=%s, end=%v) = %v, want %v", tc.status, tc.endDate, got, tc.want)
			}
		})
	}
}

func TestRule2_BoundaryAtEndIsInclusive(t *testing.T) {
	t.Parallel()
	// Given: the R2 cut-off is the frozen clock itself (no grace).
	r2, _ := worker.Thresholds(workerNow)
	cases := []struct {
		name    string
		endDate time.Time
		want    bool
	}{
		{"end exactly now auto-cancels", r2, true},
		{"end one second ahead is still active", r2.Add(time.Second), false},
		{"end one second ago auto-cancels", r2.Add(-time.Second), true},
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

func TestRule1_FutureWindowRequestSurvives(t *testing.T) {
	t.Parallel()
	// Given: a requested visit whose window has NOT started yet (start 3h in
	// the future), so neither R1 nor R2 may claim it.
	future := mkVisit("visit-r1open", domain.VisitStatusRequested,
		workerNow.Add(-time.Hour), workerNow.Add(3*time.Hour), workerNow.Add(5*time.Hour))
	r2, _ := worker.Thresholds(workerNow)
	if worker.ShouldAutoCancel(future, workerNow) {
		t.Fatal("ShouldAutoCancel = true, want false while the window has not started")
	}
	if worker.ShouldMarkNoShow(future, r2, false) {
		t.Fatal("ShouldMarkNoShow = true, want false while the window is still open")
	}
	visits := newFakeVisitRepo(future)
	rules := &fakeAutoRules{stale: []domain.VisitRequest{future}}
	svc := workerService(visits, rules, newFakeCheckInOutRepo())
	// When: the sweep runs.
	summary := svc.Run(t.Context())
	// Then: it is skipped, never cancelled nor marked a no-show.
	if summary.Cancelled != 0 {
		t.Fatalf("expected 0 cancellations, got %+v", summary)
	}
	if summary.NoShow != 0 {
		t.Fatalf("expected 0 no-shows, got %+v", summary)
	}
	if summary.Skipped < 1 {
		t.Fatalf("expected at least 1 skip, got %+v", summary)
	}
	if visits.visits[future.ID].Status != domain.VisitStatusRequested {
		t.Fatalf("expected status to stay requested, got %q", visits.visits[future.ID].Status)
	}
	if len(visits.writes) != 0 {
		t.Fatalf("expected zero status writes, got %d", len(visits.writes))
	}
}

func TestRules_OverdueStaleRequestIsR1NotR2(t *testing.T) {
	t.Parallel()
	// Given: a requested visit whose window BOTH started AND closed one hour
	// ago, so it sits inside R1's end guard and the two fake candidate lists
	// both carry it.
	both := mkVisit("visit-both", domain.VisitStatusRequested,
		workerNow.Add(-8*24*time.Hour), workerNow.Add(-5*time.Hour), workerNow.Add(-time.Hour))
	visits := newFakeVisitRepo(both)
	rules := &fakeAutoRules{
		stale:  []domain.VisitRequest{both},
		noShow: []domain.VisitRequest{both},
	}
	svc := workerService(visits, rules, newFakeCheckInOutRepo())
	// When: the sweep runs.
	summary := svc.Run(t.Context())
	// Then: R2 skips it (inside R1's guard) and R1 cancels it with the R1 note.
	if summary.NoShow != 0 {
		t.Fatalf("expected 0 no-shows, got %+v", summary)
	}
	if summary.Cancelled != 1 {
		t.Fatalf("expected 1 cancellation, got %+v", summary)
	}
	if visits.visits[both.ID].Status != domain.VisitStatusCancelled {
		t.Fatalf("expected status cancelled, got %q", visits.visits[both.ID].Status)
	}
	if len(visits.writes) != 1 || visits.writes[0].notes != "Otomatis dibatalkan: jadwal kunjungan telah dimulai tanpa persetujuan (R1)." {
		t.Fatalf("writes = %+v, want one R1 auto-cancel note", visits.writes)
	}
	if summary.Skipped < 1 {
		t.Fatalf("expected R2 to skip the requested row, got %+v", summary)
	}
}

func TestRule3_AutoCompletesAtEndDatetime(t *testing.T) {
	t.Parallel()
	// Given: a visiting permit whose end datetime has arrived (no 24h grace).
	v := mkVisit("visit-r3", domain.VisitStatusVisiting,
		workerNow.Add(-48*time.Hour), workerNow.Add(-30*time.Hour), workerNow.Add(-time.Second))
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

func TestRule3_BoundaryAtEndDatetime(t *testing.T) {
	t.Parallel()
	// Given: the R3 cut-off is the frozen clock itself (no 24h grace).
	_, r3 := worker.Thresholds(workerNow)
	cases := []struct {
		name    string
		endDate time.Time
		want    bool
	}{
		{"end exactly now is completed", r3, true},
		{"end one second ahead is not yet completed", r3.Add(time.Second), false},
		{"end one second ago is completed", r3.Add(-time.Second), true},
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
	// Then: exactly one reminder is emitted, fanned out to the vendor leg and
	// the branch-staff leg (security included).
	if summary.Reminded != 1 {
		t.Fatalf("expected 1 reminder, got %+v", summary)
	}
	if len(notif.writes) != 2 {
		t.Fatalf("expected 2 notification writes (vendor + staff), got %d", len(notif.writes))
	}
	seen := map[domain.NotificationAudience]bool{}
	for _, w := range notif.writes {
		if w.tpl == nil {
			t.Fatalf("expected a notification template, got nil")
		}
		if w.tpl.Type != domain.NotificationVisitReminder {
			t.Fatalf("expected template type %q, got %q", domain.NotificationVisitReminder, w.tpl.Type)
		}
		seen[w.tpl.Audience] = true
	}
	if !seen[domain.NotificationAudienceVendor] || !seen[domain.NotificationAudienceStaff] {
		t.Fatalf("expected one vendor and one staff reminder write, got %v", seen)
	}
	if len(summary.Failures) != 0 {
		t.Fatalf("expected no failures, got %+v", summary.Failures)
	}
}

func TestRule4_StaffLegGatedIndependentlyOfVendorLeg(t *testing.T) {
	t.Parallel()
	// Given: an approved in-window visit under a snapshot with the vendor leg
	// fully off but the staff leg on.
	v := mkVisit("visit-r4gate", domain.VisitStatusApproved,
		workerNow.Add(-time.Hour), workerNow.Add(30*time.Minute), workerNow.Add(2*time.Hour))
	visits := newFakeVisitRepo(v)
	rules := &fakeAutoRules{reminders: []domain.VisitRequest{v}}
	notif := &fakeNotificationRepo{}
	snap := domain.DefaultNotificationSettings()
	vendorOff := snap.Toggles[domain.NotificationVisitReminder]
	vendorOff.InApp.Vendor = false
	vendorOff.Email.Vendor = false
	snap.Toggles[domain.NotificationVisitReminder] = vendorOff
	svc := worker.NewService(worker.Dependencies{
		Visits:         visits,
		Rules:          rules,
		CheckIns:       newFakeCheckInOutRepo(),
		Notifications:  notif,
		Clock:          &stubClock{now: workerNow},
		SettingsLoader: stubSettingsLoader{snap: snap},
	})
	// When: the sweep runs.
	summary := svc.Run(t.Context())
	// Then: only the staff row is written, and the visit still counts.
	if summary.Reminded != 1 {
		t.Fatalf("expected 1 reminder, got %+v", summary)
	}
	if len(notif.writes) != 1 {
		t.Fatalf("expected 1 notification write (staff only), got %d", len(notif.writes))
	}
	if notif.writes[0].tpl == nil || notif.writes[0].tpl.Audience != domain.NotificationAudienceStaff {
		t.Fatalf("expected the staff reminder write, got %+v", notif.writes[0].tpl)
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
	// Then: both leg failures are collected, not aborted, and nothing counts.
	if summary.Reminded != 0 {
		t.Fatalf("expected 0 reminders, got %+v", summary)
	}
	if len(summary.Failures) != 2 {
		t.Fatalf("expected 2 collected failures (vendor + staff leg), got %+v", summary.Failures)
	}
	for _, failure := range summary.Failures {
		if failure.Rule != worker.RuleReminder {
			t.Fatalf("expected failure rule %q, got %q", worker.RuleReminder, failure.Rule)
		}
		if failure.VisitID != v.ID {
			t.Fatalf("expected failure visit %q, got %q", v.ID, failure.VisitID)
		}
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
