package repository

// Roster fan-out suite for the check-in/check-out legs: a visit roster member
// holding an email address receives the lifecycle mail whenever the
// email.vendor cell of that event is ON, and receives nothing when the cell
// is OFF. The staff leg of the same event is untouched by that cell. The
// mailer is always the domain FakeMailer: no test here dials SMTP.

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"thc-vms/backend/internal/domain"
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
