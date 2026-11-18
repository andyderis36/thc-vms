package repository

// Roster fan-out suite for the check-in/check-out legs: a visit roster member
// holding an email address receives the lifecycle mail whenever the
// email.vendor cell of that event is ON, and receives nothing when the cell
// is OFF. The staff leg of the same event is untouched by that cell. On a
// multi-entry permit the roster (and staff) mail is additionally frugal: only
// the first check-in and the final completion send email, while intermediate
// gate edges keep their in-app bell and visit_logs row. The mailer is always
// the domain FakeMailer: no test here dials SMTP.

import (
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/repository/db"
)

// rosterFanOutSettings returns the default matrix with the email.vendor cell
// of the given types forced to the wanted state, so the roster fan-out gate
// (repository/email_enqueue.go:282) can be flipped without touching the rest
// of the matrix.
func rosterFanOutSettings(vendor bool, types ...domain.NotificationType) domain.NotificationSettings {
	snap := domain.DefaultNotificationSettings()
	for _, t := range types {
		tg := snap.Toggles[t]
		tg.Email.Vendor = vendor
		snap.Toggles[t] = tg
	}
	return snap
}

// mailCountTo counts how many recorded mails were addressed to addr.
func mailCountTo(fake *domain.FakeMailer, addr string) int {
	n := 0
	for _, call := range fake.Calls {
		for _, to := range call.To {
			if to == addr {
				n++
			}
		}
	}
	return n
}

// rosterVisitParams menstage satu kunjungan approved beserta satu anggota
// roster yang punya email kontak.
type rosterVisitParams struct {
	Code        string
	MemberEmail string
}

// seedRosterVisit returns the visit id of one approved visit carrying a
// single roster member with a contact email.
func seedRosterVisit(t *testing.T, pool *pgxpool.Pool, fx emailStaffFixture, p rosterVisitParams) domain.UUID {
	t.Helper()
	start := time.Now().UTC().Add(24 * time.Hour).Truncate(time.Second)
	visitID := seedVisit(t, pool, seedVisitParams{
		Code: p.Code, VendorUser: fx.vendor, Location: fx.loc,
		Start: start, End: start.Add(4 * time.Hour), Status: domain.VisitStatusApproved,
	})
	seedVisitorRow(t, pool, visitID, "Anggota Roster", "ID-ROSTER-1", p.MemberEmail)
	return visitID
}

// TestEmailEnqueue_RosterMemberReceivesCheckInAndCheckOutMail proves the
// roster fan-out reaches a roster member holding an email address on the
// check-in and check-out legs: with the email.vendor cell ON the member gets
// one mail per transition, on top of the unchanged staff mail.
func TestEmailEnqueue_RosterMemberReceivesCheckInAndCheckOutMail(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	fx := seedEmailFixture(t, pool)
	fake := &domain.FakeMailer{}
	repos := NewVisitRepository(pool).WithMailer(fake)

	member := "member.roster@vendor.test"
	visitID := seedRosterVisit(t, pool, fx, rosterVisitParams{Code: "VST-0000000331", MemberEmail: member})

	if err := repos.UpdateStatus(ctx, visitID, domain.VisitStatusVisiting, fx.security, ""); err != nil {
		t.Fatalf("check-in UpdateStatus: %v", err)
	}
	if got := mailCountTo(fake, member); got != 1 {
		t.Fatalf("roster member mails after check-in = %d, want 1", got)
	}
	if len(fake.Calls) != 2 {
		t.Fatalf("email calls after check-in = %d, want 2 (one staff, one roster member)", len(fake.Calls))
	}
	assertStaffSplit(t, fake.Calls[0], fx)

	if err := repos.UpdateStatus(ctx, visitID, domain.VisitStatusCompleted, fx.security, ""); err != nil {
		t.Fatalf("check-out UpdateStatus: %v", err)
	}
	if got := mailCountTo(fake, member); got != 2 {
		t.Fatalf("roster member mails after check-out = %d, want 2 (one per transition)", got)
	}
	if len(fake.Calls) != 4 {
		t.Fatalf("email calls after check-out = %d, want 4 (staff + roster member per transition)", len(fake.Calls))
	}
}

// TestEmailEnqueue_RosterFanOutFollowsEmailVendorCell proves the roster
// fan-out is gated by the email.vendor cell of the event: with that cell OFF
// the roster member gets no mail on check-in nor check-out, while the staff
// leg still goes out untouched.
func TestEmailEnqueue_RosterFanOutFollowsEmailVendorCell(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	fx := seedEmailFixture(t, pool)
	fake := &domain.FakeMailer{}
	snap := rosterFanOutSettings(false, domain.NotificationVisitCheckIn, domain.NotificationVisitCheckOut)
	repos := NewVisitRepository(pool).WithMailer(fake).WithSettings(fixedSettingsLoader{snap: snap})

	member := "member.roster.off@vendor.test"
	visitID := seedRosterVisit(t, pool, fx, rosterVisitParams{Code: "VST-0000000332", MemberEmail: member})

	if err := repos.UpdateStatus(ctx, visitID, domain.VisitStatusVisiting, fx.security, ""); err != nil {
		t.Fatalf("check-in UpdateStatus: %v", err)
	}
	if got := mailCountTo(fake, member); got != 0 {
		t.Fatalf("roster member mails after check-in = %d, want 0 (email.vendor off)", got)
	}
	if len(fake.Calls) != 1 {
		t.Fatalf("email calls after check-in = %d, want 1 (staff leg only)", len(fake.Calls))
	}
	assertStaffSplit(t, fake.Calls[0], fx)

	if err := repos.UpdateStatus(ctx, visitID, domain.VisitStatusCompleted, fx.security, ""); err != nil {
		t.Fatalf("check-out UpdateStatus: %v", err)
	}
	if got := mailCountTo(fake, member); got != 0 {
		t.Fatalf("roster member mails after check-out = %d, want 0 (email.vendor off)", got)
	}
	if len(fake.Calls) != 2 {
		t.Fatalf("email calls after check-out = %d, want 2 (staff leg per transition)", len(fake.Calls))
	}
}

// visitLogCount counts the visit_logs rows recorded for one visit so a test
// can prove a gate edge kept its audit row even when its email was skipped.
func visitLogCount(t *testing.T, pool *pgxpool.Pool, visitID domain.UUID) int {
	t.Helper()
	parsed, err := fromDomainUUID(visitID)
	if err != nil {
		t.Fatalf("parse visit id: %v", err)
	}
	rows, err := db.New(pool).ListVisitLogsByVisit(testContext(t), db.ListVisitLogsByVisitParams{VisitRequestID: parsed})
	if err != nil {
		t.Fatalf("ListVisitLogsByVisit: %v", err)
	}
	return len(rows)
}

// TestEmailEnqueue_MultiEntryMailsOnlyFirstCheckInAndFinalCompletion drives
// one permit through in -> out -> in -> out -> completed and proves the email
// leg is frugal: the first check-in and the human completion mail (staff plus
// roster member), while the intermediate check-outs and the re-entry check-in
// stay email-silent yet keep their in-app bell and visit_logs row.
func TestEmailEnqueue_MultiEntryMailsOnlyFirstCheckInAndFinalCompletion(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	fx := seedEmailFixture(t, pool)
	fake := &domain.FakeMailer{}
	repos := NewVisitRepository(pool).WithMailer(fake)

	member := "member.multientry@vendor.test"
	visitID := seedRosterVisit(t, pool, fx, rosterVisitParams{Code: "VST-0000000341", MemberEmail: member})

	// First check-in: the one gate entry that mails (staff + roster member).
	if err := repos.UpdateStatus(ctx, visitID, domain.VisitStatusVisiting, fx.security, ""); err != nil {
		t.Fatalf("first check-in UpdateStatus: %v", err)
	}
	if len(fake.Calls) != 2 {
		t.Fatalf("email calls after first check-in = %d, want 2 (staff + roster member)", len(fake.Calls))
	}
	if got := mailCountTo(fake, member); got != 1 {
		t.Fatalf("roster member mails after first check-in = %d, want 1", got)
	}
	assertStaffSplit(t, fake.Calls[0], fx)
	if got := visitLogCount(t, pool, visitID); got != 1 {
		t.Fatalf("visit_logs rows after first check-in = %d, want 1", got)
	}

	// Intermediate check-out: no email, but the bell and log row land.
	if err := repos.UpdateStatus(ctx, visitID, domain.VisitStatusOffsite, fx.security, ""); err != nil {
		t.Fatalf("intermediate check-out UpdateStatus: %v", err)
	}
	if len(fake.Calls) != 2 {
		t.Fatalf("email calls after intermediate check-out = %d, want 2 (no mail on a non-first edge)", len(fake.Calls))
	}
	if got := visitLogCount(t, pool, visitID); got != 2 {
		t.Fatalf("visit_logs rows after intermediate check-out = %d, want 2", got)
	}
	if n := countTypedNotifs(t, pool, fx.admin, visitID, domain.NotificationVisitCheckOut); n != 1 {
		t.Fatalf("staff in_app visit_check_out rows = %d, want 1 (bell written even when email is skipped)", n)
	}

	// Re-entry check-in: still silent on email, still logged.
	if err := repos.UpdateStatus(ctx, visitID, domain.VisitStatusVisiting, fx.security, ""); err != nil {
		t.Fatalf("re-entry check-in UpdateStatus: %v", err)
	}
	if len(fake.Calls) != 2 {
		t.Fatalf("email calls after re-entry check-in = %d, want 2 (only the first check-in mails)", len(fake.Calls))
	}
	if got := mailCountTo(fake, member); got != 1 {
		t.Fatalf("roster member mails after re-entry check-in = %d, want 1 (no second mail)", got)
	}
	if got := visitLogCount(t, pool, visitID); got != 3 {
		t.Fatalf("visit_logs rows after re-entry check-in = %d, want 3", got)
	}
	if n := countTypedNotifs(t, pool, fx.admin, visitID, domain.NotificationVisitCheckIn); n != 1 {
		t.Fatalf("staff in_app visit_check_in rows = %d, want 1 (bell row present)", n)
	}

	// Second check-out: silent again, fourth log row.
	if err := repos.UpdateStatus(ctx, visitID, domain.VisitStatusOffsite, fx.security, ""); err != nil {
		t.Fatalf("second check-out UpdateStatus: %v", err)
	}
	if len(fake.Calls) != 2 {
		t.Fatalf("email calls after second check-out = %d, want 2", len(fake.Calls))
	}
	if got := visitLogCount(t, pool, visitID); got != 4 {
		t.Fatalf("visit_logs rows after second check-out = %d, want 4", got)
	}

	// Final completion: human Selesaikan mails again (staff + roster member).
	if err := repos.UpdateStatus(ctx, visitID, domain.VisitStatusCompleted, fx.security, "selesai"); err != nil {
		t.Fatalf("completion UpdateStatus: %v", err)
	}
	if len(fake.Calls) != 4 {
		t.Fatalf("email calls after completion = %d, want 4 (first check-in + completion)", len(fake.Calls))
	}
	if got := mailCountTo(fake, member); got != 2 {
		t.Fatalf("roster member mails after completion = %d, want 2 (first check-in + completion)", got)
	}
	if got := visitLogCount(t, pool, visitID); got != 4 {
		t.Fatalf("visit_logs rows after completion = %d, want 4 (completion is not a gate edge)", got)
	}
}

// TestEmailEnqueue_SystemCompleteAfterOffsiteStillMails proves the R3
// auto-complete keeps its email after a multi-entry permit sits offsite: the
// intermediate check-out mails nothing, then the system move to completed fans
// out the usual staff plus roster mail marked (Otomatis).
func TestEmailEnqueue_SystemCompleteAfterOffsiteStillMails(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	fx := seedEmailFixture(t, pool)
	fake := &domain.FakeMailer{}
	repos := NewVisitRepository(pool).WithMailer(fake)

	member := "member.offsite@vendor.test"
	visitID := seedRosterVisit(t, pool, fx, rosterVisitParams{Code: "VST-0000000342", MemberEmail: member})

	if err := repos.UpdateStatus(ctx, visitID, domain.VisitStatusVisiting, fx.security, ""); err != nil {
		t.Fatalf("check-in UpdateStatus: %v", err)
	}
	if err := repos.UpdateStatus(ctx, visitID, domain.VisitStatusOffsite, fx.security, ""); err != nil {
		t.Fatalf("check-out UpdateStatus: %v", err)
	}
	if len(fake.Calls) != 2 {
		t.Fatalf("email calls after check-out = %d, want 2 (first check-in only)", len(fake.Calls))
	}

	if err := repos.UpdateStatus(ctx, visitID, domain.VisitStatusCompleted, "", "auto-rule R3"); err != nil {
		t.Fatalf("system complete UpdateStatus: %v", err)
	}
	if len(fake.Calls) != 4 {
		t.Fatalf("email calls after R3 complete = %d, want 4 (staff + roster member)", len(fake.Calls))
	}
	assertStaffSplit(t, fake.Calls[2], fx)
	if !strings.Contains(fake.Calls[2].Subject, "(Otomatis)") {
		t.Fatalf("R3 subject = %q, want the (Otomatis) marker", fake.Calls[2].Subject)
	}
	if got := mailCountTo(fake, member); got != 2 {
		t.Fatalf("roster member mails after R3 complete = %d, want 2", got)
	}
}
