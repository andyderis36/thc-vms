package domain_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
)

// emailAllowedCases is the locked allowlist expectation: exactly these seven
// notification types may fan out to email; everything else stays in_app-only.
var emailAllowedCases = []struct {
	typ   domain.NotificationType
	allow bool
}{
	{domain.NotificationVisitApproved, true},
	{domain.NotificationVisitRejected, true},
	{domain.NotificationVisitCancelled, true},
	{domain.NotificationVisitRescheduled, true},
	{domain.NotificationVisitReminder, true},
	{domain.NotificationVisitCheckIn, true},
	{domain.NotificationVisitCheckOut, true},
	{domain.NotificationVisitRequested, false},
	{domain.NotificationVisitAutoCancelled, false},
	{domain.NotificationType(""), false},
	{domain.NotificationType("visit_deleted"), false},
}

// TestEmailAllowed_AllowsExactlySevenTypes proves the allowlist admits the
// seven email-safe lifecycle types and nothing else.
func TestEmailAllowed_AllowsExactlySevenTypes(t *testing.T) {
	for _, tc := range emailAllowedCases {
		if got := domain.EmailAllowed(tc.typ); got != tc.allow {
			t.Errorf("EmailAllowed(%q) = %v, want %v", tc.typ, got, tc.allow)
		}
	}
}

// emailSubjectCases pins the locked subject table:
// [THC-VMS] <Judul> — {visit_code}.
var emailSubjectCases = []struct {
	typ   domain.NotificationType
	judul string
}{
	{domain.NotificationVisitApproved, "Kunjungan Disetujui"},
	{domain.NotificationVisitRejected, "Kunjungan Ditolak"},
	{domain.NotificationVisitCancelled, "Kunjungan Dibatalkan"},
	{domain.NotificationVisitRescheduled, "Jadwal Diubah"},
	{domain.NotificationVisitReminder, "Pengingat Kunjungan (H-1)"},
	{domain.NotificationVisitCheckIn, "Check-in Tercatat"},
	{domain.NotificationVisitCheckOut, "Check-out Tercatat"},
}

// testVisit builds a visit carrying location, schedule and reason context for
// the template tests.
func testVisit() domain.VisitRequest {
	reason := "Berkas kurang lengkap"
	return domain.VisitRequest{
		VisitID:      "VST-0000000001",
		LocationName: "POP Tebet",
		StartDate:    time.Date(2026, 11, 10, 9, 0, 0, 0, time.UTC),
		EndDate:      time.Date(2026, 11, 10, 17, 0, 0, 0, time.UTC),
		StatusNote:   &reason,
	}
}

// TestBuildEmail_SubjectConvention proves every allowlisted type renders the
// locked subject shape with its own Judul and the visit code.
func TestBuildEmail_SubjectConvention(t *testing.T) {
	visit := testVisit()
	for _, tc := range emailSubjectCases {
		tpl := &domain.NotificationTemplate{Type: tc.typ, Title: "judul in-app", Message: "pesan in-app"}
		subject, _, _ := domain.BuildEmail(visit, tpl)
		want := "[THC-VMS] " + tc.judul + " — " + visit.VisitID
		if subject != want {
			t.Errorf("BuildEmail(%q) subject = %q, want %q", tc.typ, subject, want)
		}
	}
}

// TestBuildEmail_TextBodyIsMessageVerbatim proves the text part is the in_app
// Message byte-for-byte: one copy, two channels.
func TestBuildEmail_TextBodyIsMessageVerbatim(t *testing.T) {
	visit := testVisit()
	tpl := domain.HumanCancelledNotification(visit.VisitID, false)
	_, textBody, _ := domain.BuildEmail(visit, tpl)
	if textBody != tpl.Message {
		t.Errorf("textBody = %q, want in_app Message %q verbatim", textBody, tpl.Message)
	}
}

// TestBuildEmail_HTMLWrapsTitleMessageAndContext proves the HTML part reuses
// the in_app Title/Message and adds the visit context rows.
func TestBuildEmail_HTMLWrapsTitleMessageAndContext(t *testing.T) {
	visit := testVisit()
	tpl := domain.HumanCancelledNotification(visit.VisitID, false)
	_, _, htmlBody := domain.BuildEmail(visit, tpl)
	for _, want := range []string{tpl.Title, tpl.Message, visit.VisitID, visit.LocationName, "Berkas kurang lengkap"} {
		if !strings.Contains(htmlBody, want) {
			t.Errorf("htmlBody missing %q:\n%s", want, htmlBody)
		}
	}
	if !strings.Contains(htmlBody, "<html") || !strings.Contains(htmlBody, "</html>") {
		t.Errorf("htmlBody is not a full document:\n%s", htmlBody)
	}
}

// TestBuildEmail_HTMLEscapesAllFields proves every interpolated field is
// HTML-escaped so vendor-controlled text can never break the markup.
func TestBuildEmail_HTMLEscapesAllFields(t *testing.T) {
	reason := "<script>alert('x')</script>"
	visit := domain.VisitRequest{
		VisitID:      "VST-<b>1</b>",
		LocationName: "POP <img src=x onerror=alert(1)>",
		StartDate:    time.Date(2026, 11, 10, 9, 0, 0, 0, time.UTC),
		EndDate:      time.Date(2026, 11, 10, 17, 0, 0, 0, time.UTC),
		StatusNote:   &reason,
	}
	tpl := &domain.NotificationTemplate{
		Type:     domain.NotificationVisitApproved,
		Title:    "Kunjungan <em>disetujui</em>",
		Message:  "Permintaan VST-<b>1</b> telah disetujui.",
		Audience: domain.NotificationAudienceVendor,
	}
	_, _, htmlBody := domain.BuildEmail(visit, tpl)
	for _, raw := range []string{
		"VST-<b>1</b>", "<em>disetujui</em>", "<img src=x onerror=alert(1)>", "<script>alert('x')</script>",
	} {
		if strings.Contains(htmlBody, raw) {
			t.Errorf("htmlBody contains unescaped %q:\n%s", raw, htmlBody)
		}
	}
}

// TestBuildEmail_HTMLOmitsReasonWhenAbsent proves the reason row is skipped
// when the visit carries no status note.
func TestBuildEmail_HTMLOmitsReasonWhenAbsent(t *testing.T) {
	visit := testVisit()
	visit.StatusNote = nil
	tpl := domain.TransitionNotification(domain.VisitStatusApproved, false, visit.VisitID)
	_, _, htmlBody := domain.BuildEmail(visit, tpl)
	if strings.Contains(htmlBody, "Berkas kurang lengkap") {
		t.Errorf("htmlBody should omit the reason row when StatusNote is nil:\n%s", htmlBody)
	}
}

// TestFakeMailer_RecordsCalls proves the fake captures every Send for
// assertions without touching the network.
func TestFakeMailer_RecordsCalls(t *testing.T) {
	fake := &domain.FakeMailer{}
	var _ domain.Mailer = fake // fake must satisfy the port
	ctx := context.Background()
	if err := fake.Send(ctx, []string{"vendor@example.com"}, "s", "t", "<p>h</p>"); err != nil {
		t.Fatalf("FakeMailer.Send() = %v, want nil", err)
	}
	if len(fake.Calls) != 1 {
		t.Fatalf("len(Calls) = %d, want 1", len(fake.Calls))
	}
	call := fake.Calls[0]
	if len(call.To) != 1 || call.To[0] != "vendor@example.com" {
		t.Errorf("To = %v, want [vendor@example.com]", call.To)
	}
	if call.Subject != "s" || call.TextBody != "t" || call.HTMLBody != "<p>h</p>" {
		t.Errorf("call = %+v, want the exact subject/text/html passed to Send", call)
	}
}

// TestEmailGate_ExcludedTypesNeverReachSend proves the enqueue-time contract:
// callers check EmailAllowed first, so visit_requested and
// visit_auto_cancelled never produce a Send call.
func TestEmailGate_ExcludedTypesNeverReachSend(t *testing.T) {
	fake := &domain.FakeMailer{}
	ctx := context.Background()
	visit := testVisit()
	templates := []*domain.NotificationTemplate{
		domain.CreatedNotification(visit.VisitID),
		domain.TransitionNotification(domain.VisitStatusCancelled, true, visit.VisitID),
	}
	for _, tpl := range templates {
		if tpl == nil {
			continue
		}
		if !domain.EmailAllowed(tpl.Type) {
			continue // the gate: excluded types are dropped before Send
		}
		subject, textBody, htmlBody := domain.BuildEmail(visit, tpl)
		if err := fake.Send(ctx, []string{"vendor@example.com"}, subject, textBody, htmlBody); err != nil {
			t.Fatal(err)
		}
	}
	if len(fake.Calls) != 0 {
		t.Errorf("len(Calls) = %d, want 0: excluded types must never reach Send", len(fake.Calls))
	}
}

// TestBuildEmail_TeamQRImageOnlyOnApproval proves the inline team QR image
// and note render only on the approval mail; every other event keeps the
// Kode-kunjungan text row as its sole code reference.
func TestBuildEmail_TeamQRImageOnlyOnApproval(t *testing.T) {
	visit := testVisit()
	for _, tc := range emailSubjectCases {
		tpl := &domain.NotificationTemplate{Type: tc.typ, Title: "judul in-app", Message: "pesan in-app"}
		_, _, htmlBody := domain.BuildEmail(visit, tpl)
		hasImg := strings.Contains(htmlBody, "cid:"+domain.TeamQRCID(visit.VisitID))
		hasNote := strings.Contains(htmlBody, "Satu QR Code untuk 1 tim")
		if tc.typ == domain.NotificationVisitApproved {
			if !hasImg || !hasNote {
				t.Errorf("approval HTML missing the inline team QR block:\n%s", htmlBody)
			}
			continue
		}
		if hasImg || hasNote {
			t.Errorf("non-approval %q HTML carries the team QR block", tc.typ)
		}
		if !strings.Contains(htmlBody, visit.VisitID) {
			t.Errorf("non-approval %q HTML lost the Kode-kunjungan text fallback", tc.typ)
		}
	}
}

func TestRenderBrandedActionEmail_ButtonAndEscaping(t *testing.T) {
	htmlBody := domain.RenderBrandedActionEmail(
		"Verifikasi Alamat Email Baru",
		"Klik tombol berikut. Abaikan bila bukan Anda.",
		"Verifikasi Email",
		"https://vms.example.com/verify-email?token=abc",
	)
	for _, want := range []string{
		"THC Visitor Management System",
		"Verifikasi Alamat Email Baru",
		"Verifikasi Email",
		"https://vms.example.com/verify-email?token=abc",
		"background-color:#422AD5",
	} {
		if !strings.Contains(htmlBody, want) {
			t.Errorf("htmlBody missing %q", want)
		}
	}

	bare := domain.RenderBrandedActionEmail("Judul", "Pesan <b>tautan</b> & \"kutip\"", "", "")
	if strings.Contains(bare, "<a href=") {
		t.Error("empty CTA must render no button")
	}
	if strings.Contains(bare, "<b>tautan</b>") || strings.Contains(bare, `"kutip"`) {
		t.Error("interpolated fields must be HTML-escaped")
	}
}
