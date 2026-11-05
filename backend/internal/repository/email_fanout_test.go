package repository

// Member fan-out suite (async, after-commit only): every visit event the
// requester gets today is fanned out per recipient to the requester AND each
// roster member carrying a non-blank email. The approval mail additionally
// carries ONE team QR (payload = VST- code) as an inline-CID image plus the
// team note copy. Blank member emails mean no mail, never an error. The
// mailer is always the domain FakeMailer: no test here dials SMTP.

import (
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"thc-vms/backend/internal/domain"
)

// seedVisitorRow stages one roster member with the given contact email; a
// blank email stores SQL NULL (both mean "no mail").
func seedVisitorRow(t *testing.T, pool *pgxpool.Pool, visit domain.UUID, name, idNumber, email string) {
	t.Helper()
	var em any
	if strings.TrimSpace(email) == "" {
		em = nil
	} else {
		em = email
	}
	if _, err := pool.Exec(testContext(t),
		`INSERT INTO visitor (visit_request_id, name, id_number, phone, email)
		 VALUES ($1, $2, $3, $4, $5)`,
		uuidArg(visit), name, idNumber, "0811000000", em); err != nil {
		t.Fatalf("seed visitor %s: %v", name, err)
	}
}

// assertPNGMagic proves the team QR bytes are a real PNG document.
func assertPNGMagic(t *testing.T, qr []byte) {
	t.Helper()
	magic := []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A}
	if len(qr) < len(magic) {
		t.Fatalf("team QR is %d bytes, want at least the PNG header", len(qr))
	}
	for i := range magic {
		if qr[i] != magic[i] {
			t.Fatalf("team QR bytes are not a PNG document")
		}
	}
}

// TestEmailEnqueue_ApprovedFansOutToRequesterAndMembers proves an approval
// with two member emails enqueues exactly three mails sharing one VST- code
// (requester + two members), each carrying the same team QR bytes and CID,
// with the inline image and team note in the HTML.
func TestEmailEnqueue_ApprovedFansOutToRequesterAndMembers(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	fx := seedEmailFixture(t, pool)
	fake := &domain.FakeMailer{}
	repos := NewVisitRepository(pool).WithMailer(fake)

	visitID := seedEmailVisit(t, pool, "VST-0000000321", fx)
	seedVisitorRow(t, pool, visitID, "Anggota Satu", "ID-FANOUT-1", "member.satu@vendor.test")
	seedVisitorRow(t, pool, visitID, "Anggota Dua", "ID-FANOUT-2", "member.dua@vendor.test")
	seedVisitorRow(t, pool, visitID, "Anggota Sunyi", "ID-FANOUT-3", "")

	if err := repos.UpdateStatus(ctx, visitID, domain.VisitStatusApproved, fx.admin, "disetujui"); err != nil {
		t.Fatalf("UpdateStatus approved: %v", err)
	}
	if len(fake.Calls) != 3 {
		t.Fatalf("email calls = %d, want 3 (requester + 2 member emails)", len(fake.Calls))
	}
	wantTo := map[string]bool{fx.vendorEmail: false, "member.satu@vendor.test": false, "member.dua@vendor.test": false}
	var qr []byte
	var cid string
	for i, call := range fake.Calls {
		if !strings.Contains(call.Subject, "VST-0000000321") {
			t.Fatalf("call %d subject = %q, want the visit code", i, call.Subject)
		}
		if len(call.To) != 1 {
			t.Fatalf("call %d To = %v, want exactly one recipient per enqueue", i, call.To)
		}
		if _, ok := wantTo[call.To[0]]; !ok {
			t.Fatalf("call %d To = %v, want one of requester + members", i, call.To)
		}
		wantTo[call.To[0]] = true
		if i == 0 {
			qr, cid = call.QRPNG, call.QRCID
		} else if string(call.QRPNG) != string(qr) || call.QRCID != cid {
			t.Fatalf("call %d QR differs: want the ONE shared team QR", i)
		}
		if !strings.Contains(call.HTMLBody, "cid:"+cid) {
			t.Fatalf("call %d HTML missing the inline team QR image", i)
		}
	}
	for addr, seen := range wantTo {
		if !seen {
			t.Fatalf("recipient %s got no mail, want one enqueue each", addr)
		}
	}
	if len(qr) == 0 {
		t.Fatal("team QR bytes are empty, want the encoded VST- payload")
	}
	if cid == "" || !strings.Contains(cid, "VST-0000000321") {
		t.Fatalf("team QR CID = %q, want the deterministic qr-<VST-code>", cid)
	}
	assertPNGMagic(t, qr)
	if !strings.Contains(fake.Calls[0].HTMLBody, "Satu QR Code untuk 1 tim") {
		t.Fatalf("approval HTML missing the team note copy:\n%s", fake.Calls[0].HTMLBody)
	}
}

// TestEmailEnqueue_RejectedFansOutWithoutQR proves a non-approved event also
// fans out per recipient to requester + members, but carries no team QR.
func TestEmailEnqueue_RejectedFansOutWithoutQR(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	fx := seedEmailFixture(t, pool)
	fake := &domain.FakeMailer{}
	repos := NewVisitRepository(pool).WithMailer(fake)

	visitID := seedEmailVisit(t, pool, "VST-0000000322", fx)
	seedVisitorRow(t, pool, visitID, "Anggota Tiga", "ID-FANOUT-4", "member.tiga@vendor.test")

	if err := repos.UpdateStatus(ctx, visitID, domain.VisitStatusRejected, fx.admin, "berkas kurang"); err != nil {
		t.Fatalf("UpdateStatus rejected: %v", err)
	}
	if len(fake.Calls) != 2 {
		t.Fatalf("email calls = %d, want 2 (requester + 1 member email)", len(fake.Calls))
	}
	for i, call := range fake.Calls {
		if !strings.Contains(call.Subject, "VST-0000000322") {
			t.Fatalf("call %d subject = %q, want the visit code", i, call.Subject)
		}
		if len(call.QRPNG) != 0 || call.QRCID != "" {
			t.Fatalf("call %d carries a team QR, want none outside approvals", i)
		}
		if strings.Contains(call.HTMLBody, "cid:") {
			t.Fatalf("call %d HTML references an inline image, want none outside approvals", i)
		}
	}
}
