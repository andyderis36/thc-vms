package domain_test

// Render-side suite for the lifecycle email builders (email_render.go): the
// subject renders from the SAME template Title as the HTML H2, the Tautan QR
// link appears only on the approval mail, human transitions carry actor rows
// in both bodies, and no bare UUID is ever printed.

import (
	"regexp"
	"strings"
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
)

// lifecycleTemplates builds the PRODUCTION template for each allowlisted
// type, so the golden assertions render exactly what the enqueue hooks
// render. The cancel entry carries a resolved actor fragment like the
// repository builds it.
func lifecycleTemplates(visitCode string) map[domain.NotificationType]*domain.NotificationTemplate {
	return map[domain.NotificationType]*domain.NotificationTemplate{
		domain.NotificationVisitApproved:    domain.TransitionNotification(domain.VisitStatusApproved, false, visitCode),
		domain.NotificationVisitRejected:    domain.TransitionNotification(domain.VisitStatusRejected, false, visitCode),
		domain.NotificationVisitCancelled:   domain.HumanCancelledNotification(visitCode, false, "Budi Santoso (Admin Cabang)"),
		domain.NotificationVisitRescheduled: domain.TransitionNotification(domain.VisitStatusRescheduled, false, visitCode),
		domain.NotificationVisitReminder:    domain.ReminderNotification(visitCode),
		domain.NotificationVisitCheckIn:     domain.TransitionNotification(domain.VisitStatusVisiting, false, visitCode),
		domain.NotificationVisitCheckOut:    domain.TransitionNotification(domain.VisitStatusCompleted, false, visitCode),
	}
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

// testVisitWithActors adds the resolved actor rows the repository pins onto
// the email context: who filed the request and who approved it.
func testVisitWithActors() domain.VisitRequest {
	visit := testVisit()
	requester := "Budi Santoso"
	requesterRole := "Vendor/Mitra"
	actor := "Budi Santoso"
	actorRole := "Admin Cabang"
	visit.CreatedByName = &requester
	visit.CreatedByRoleLabel = &requesterRole
	visit.ActorName = &actor
	visit.ActorRoleLabel = &actorRole
	return visit
}

// TestBuildEmail_SubjectUsesTemplateTitle proves the subject renders from the
// SAME template Title shown as the HTML H2, so subject and heading can never
// drift: subject == "[THC-VMS] <tpl.Title> — {visit_code}" for every
// allowlisted type built by its production constructor.
func TestBuildEmail_SubjectUsesTemplateTitle(t *testing.T) {
	visit := testVisit()
	for typ, tpl := range lifecycleTemplates(visit.VisitID) {
		subject, _, htmlBody := domain.BuildEmail(visit, tpl)
		want := "[THC-VMS] " + tpl.Title + " — " + visit.VisitID
		if subject != want {
			t.Errorf("BuildEmail(%q) subject = %q, want %q", typ, subject, want)
		}
		if !strings.Contains(htmlBody, ">"+tpl.Title+"</h2>") {
			t.Errorf("BuildEmail(%q) HTML H2 does not carry the same Title %q", typ, tpl.Title)
		}
	}
}

// TestBuildEmail_GoldenLifecycle pins the four email contracts in one sweep
// over the seven allowlisted types: (i) the subject carries the canonical
// Title, (ii) the Tautan QR link appears ONLY on the approval mail (text and
// HTML), (iii) every human transition carries its actor row in BOTH bodies,
// (iv) no bare UUID is printed anywhere.
func TestBuildEmail_GoldenLifecycle(t *testing.T) {
	visit := testVisitWithActors()
	uuidPattern := regexp.MustCompile(`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`)
	actorRow := map[domain.NotificationType]string{
		domain.NotificationVisitApproved:    "Disetujui oleh: Budi Santoso (Admin Cabang)",
		domain.NotificationVisitRejected:    "Ditolak oleh: Budi Santoso (Admin Cabang)",
		domain.NotificationVisitCancelled:   "Dibatalkan oleh: Budi Santoso (Admin Cabang)",
		domain.NotificationVisitRescheduled: "Diubah oleh: Budi Santoso (Admin Cabang)",
		domain.NotificationVisitCheckIn:     "Petugas check-in: Budi Santoso (Admin Cabang)",
		domain.NotificationVisitCheckOut:    "Petugas check-out: Budi Santoso (Admin Cabang)",
	}
	for typ, tpl := range lifecycleTemplates(visit.VisitID) {
		subject, textBody, htmlBody := domain.BuildEmail(visit, tpl, "https://vms.example.com")
		if !strings.Contains(subject, tpl.Title) {
			t.Errorf("%q subject %q lost the canonical Title %q", typ, subject, tpl.Title)
		}
		// (ii) QR link only on approval, in both bodies.
		hasQRText := strings.Contains(textBody, "Tautan QR")
		hasQRHTML := strings.Contains(htmlBody, ">Tautan QR</a>")
		if typ == domain.NotificationVisitApproved {
			if !hasQRText || !hasQRHTML {
				t.Errorf("%q must carry the Tautan QR link (text=%v html=%v)", typ, hasQRText, hasQRHTML)
			}
		} else if hasQRText || hasQRHTML {
			t.Errorf("%q leaks the Tautan QR link (text=%v html=%v)", typ, hasQRText, hasQRHTML)
		}
		// (iii) requester row on every lifecycle mail: "Label: value" in
		// text, label and value cells in HTML.
		if !strings.Contains(textBody, "Diajukan oleh: Budi Santoso (Vendor/Mitra)") {
			t.Errorf("%q text body missing the Diajukan-oleh row:\n%s", typ, textBody)
		}
		for _, frag := range []string{"Diajukan oleh", "Budi Santoso (Vendor/Mitra)"} {
			if !strings.Contains(htmlBody, frag) {
				t.Errorf("%q HTML body missing the Diajukan-oleh fragment %q", typ, frag)
			}
		}
		// (iii) transition actor row for human transitions, both bodies.
		if want, ok := actorRow[typ]; ok {
			if !strings.Contains(textBody, want) {
				t.Errorf("%q text body missing the actor row %q:\n%s", typ, want, textBody)
			}
			label, value, _ := strings.Cut(want, ": ")
			for _, frag := range []string{label, value} {
				if !strings.Contains(htmlBody, frag) {
					t.Errorf("%q HTML body missing the actor-row fragment %q", typ, frag)
				}
			}
		}
		// (iv) no bare UUID anywhere.
		for name, body := range map[string]string{"text": textBody, "html": htmlBody} {
			if loc := uuidPattern.FindString(body); loc != "" {
				t.Errorf("%q %s body prints a bare UUID %q", typ, name, loc)
			}
		}
	}
}

// TestBuildEmail_SystemTransitionsOmitActorRow proves worker/system
// transitions never invent an actor: with nil actor fields no transition
// actor row renders, while the requester row (created_by) still shows.
func TestBuildEmail_SystemTransitionsOmitActorRow(t *testing.T) {
	visit := testVisit()
	requester := "Budi Santoso"
	requesterRole := "Vendor/Mitra"
	visit.CreatedByName = &requester
	visit.CreatedByRoleLabel = &requesterRole
	for _, typ := range []domain.NotificationType{
		domain.NotificationVisitApproved,
		domain.NotificationVisitCancelled,
		domain.NotificationVisitRescheduled,
		domain.NotificationVisitReminder,
	} {
		tpl := lifecycleTemplates(visit.VisitID)[typ]
		_, textBody, htmlBody := domain.BuildEmail(visit, tpl)
		for _, forbidden := range []string{"Disetujui oleh", "Ditolak oleh", "Diubah oleh", "Dibatalkan oleh", "Petugas check-in", "Petugas check-out"} {
			if strings.Contains(textBody, forbidden) || strings.Contains(htmlBody, forbidden) {
				t.Errorf("%q invents an actor row %q without resolved actor data", typ, forbidden)
			}
		}
		if !strings.Contains(textBody, "Diajukan oleh: Budi Santoso (Vendor/Mitra)") {
			t.Errorf("%q lost the Diajukan-oleh row:\n%s", typ, textBody)
		}
	}
}

// TestBuildEmail_TextBodyMirrorsContext proves the text part carries the in_app
// Message plus the visit context rows.
func TestBuildEmail_TextBodyMirrorsContext(t *testing.T) {
	visit := testVisit()
	tpl := domain.HumanCancelledNotification(visit.VisitID, false, "")
	_, textBody, _ := domain.BuildEmail(visit, tpl)
	if !strings.Contains(textBody, tpl.Message) {
		t.Errorf("textBody = %q, want in_app Message %q", textBody, tpl.Message)
	}
	for _, want := range []string{"Kode kunjungan", visit.VisitID, "Lokasi", visit.LocationName} {
		if !strings.Contains(textBody, want) {
			t.Errorf("textBody missing %q:\n%s", want, textBody)
		}
	}
}

// TestBuildEmail_HTMLWrapsTitleMessageAndContext proves the HTML part reuses
// the in_app Title/Message and adds the visit context rows.
func TestBuildEmail_HTMLWrapsTitleMessageAndContext(t *testing.T) {
	visit := testVisit()
	tpl := domain.HumanCancelledNotification(visit.VisitID, false, "")
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

// TestBuildEmail_TeamQRImageOnlyOnApproval proves the inline team QR image
// and note render only on the approval mail; every other event keeps the
// Kode-kunjungan text row as its sole code reference.
func TestBuildEmail_TeamQRImageOnlyOnApproval(t *testing.T) {
	visit := testVisit()
	for typ, tpl := range lifecycleTemplates(visit.VisitID) {
		_, _, htmlBody := domain.BuildEmail(visit, tpl)
		hasImg := strings.Contains(htmlBody, "cid:"+domain.TeamQRCID(visit.VisitID))
		hasNote := strings.Contains(htmlBody, "Satu QR Code untuk 1 tim")
		if typ == domain.NotificationVisitApproved {
			if !hasImg || !hasNote {
				t.Errorf("approval HTML missing the inline team QR block:\n%s", htmlBody)
			}
			continue
		}
		if hasImg || hasNote {
			t.Errorf("non-approval %q HTML carries the team QR block", typ)
		}
		if !strings.Contains(htmlBody, visit.VisitID) {
			t.Errorf("non-approval %q HTML lost the Kode-kunjungan text fallback", typ)
		}
	}
}

// TestRenderVisitEmailSamples renders the human-transition mails exactly as
// the enqueue hooks build them (resolved actor rows, frontend base URL) and
// logs the subject + text body of each, so a human can eyeball the final
// copy without sending anything.
func TestRenderVisitEmailSamples(t *testing.T) {
	visit := testVisitWithActors()
	const base = "https://vms.example.com"
	samples := []struct {
		label string
		tpl   *domain.NotificationTemplate
	}{
		{"approved", lifecycleTemplates(visit.VisitID)[domain.NotificationVisitApproved]},
		{"rescheduled", lifecycleTemplates(visit.VisitID)[domain.NotificationVisitRescheduled]},
		{"cancelled-by-admin", lifecycleTemplates(visit.VisitID)[domain.NotificationVisitCancelled]},
		{"cancelled-by-vendor", domain.HumanCancelledNotification(visit.VisitID, true, "Budi Santoso (Vendor/Mitra)")},
		{"check-in", lifecycleTemplates(visit.VisitID)[domain.NotificationVisitCheckIn]},
	}
	for _, s := range samples {
		subject, textBody, _ := domain.BuildEmail(visit, s.tpl, base)
		t.Logf("=== %s ===\nSUBJECT: %s\n%s", s.label, subject, textBody)
	}
}

// TestBuildEmail_RendersCompanyPurposesNotes proves the enriched lifecycle
// context rows land in BOTH bodies: the resolved company, the comma-separated
// purpose names and the free-typed purpose note / notes, with blanks skipped.
func TestBuildEmail_RendersCompanyPurposesNotes(t *testing.T) {
	visit := testVisit()
	visit.VendorName = "PT Lintas Fiber"
	visit.Purposes = []domain.Purpose{
		{Name: "Maintenance Genset"},
		{Name: "   "},
		{Name: " Splicing FO "},
	}
	purposeNote := "  Cek backbone POP Tebet  "
	notes := " Bawa alat ukur dan APD "
	visit.PurposeNote = &purposeNote
	visit.Notes = &notes
	tpl := domain.TransitionNotification(domain.VisitStatusApproved, false, visit.VisitID)

	_, textBody, htmlBody := domain.BuildEmail(visit, tpl)
	textRows := []string{
		"Vendor/Perusahaan: PT Lintas Fiber",
		"Keperluan: Maintenance Genset, Splicing FO",
		"Tujuan lain: Cek backbone POP Tebet",
		"Catatan: Bawa alat ukur dan APD",
	}
	for _, want := range textRows {
		if !strings.Contains(textBody, want) {
			t.Errorf("text body missing %q:\n%s", want, textBody)
		}
	}
	for _, frag := range []string{
		"Vendor/Perusahaan", "PT Lintas Fiber",
		"Keperluan", "Maintenance Genset, Splicing FO",
		"Tujuan lain", "Cek backbone POP Tebet",
		"Catatan", "Bawa alat ukur dan APD",
	} {
		if !strings.Contains(htmlBody, frag) {
			t.Errorf("HTML body missing %q", frag)
		}
	}
	// Row order: company/purpose context follows Jadwal, Catatan follows Alasan.
	if strings.Index(htmlBody, "Vendor/Perusahaan") < strings.Index(htmlBody, "Jadwal") {
		t.Error("Vendor/Perusahaan must render after Jadwal")
	}
	if strings.Index(htmlBody, "Catatan") < strings.Index(htmlBody, "Alasan") {
		t.Error("Catatan must render after Alasan")
	}
}

// TestBuildEmail_OmitsEmptyExtraContextRows proves the new rows never print an
// empty label when the visit carries no company, purposes, purpose note or
// notes.
func TestBuildEmail_OmitsEmptyExtraContextRows(t *testing.T) {
	visit := testVisit()
	visit.VendorName = ""
	visit.Purposes = nil
	visit.PurposeNote = nil
	visit.Notes = nil
	tpl := domain.TransitionNotification(domain.VisitStatusApproved, false, visit.VisitID)

	_, textBody, htmlBody := domain.BuildEmail(visit, tpl)
	for _, forbidden := range []string{"Vendor/Perusahaan", "Keperluan", "Tujuan lain", "Catatan"} {
		if strings.Contains(textBody, forbidden) || strings.Contains(htmlBody, forbidden) {
			t.Errorf("empty context row %q must be omitted", forbidden)
		}
	}
}

// TestBuildEmail_EscapesExtraContextRows proves the new vendor-controlled
// fields are HTML-escaped so a company or note cannot break the markup.
func TestBuildEmail_EscapesExtraContextRows(t *testing.T) {
	visit := testVisit()
	visit.VendorName = "PT <b>Bold</b> & Co"
	purposeNote := "<script>alert('purpose')</script>"
	notes := `"Catatan" <img src=x onerror=alert(1)>`
	visit.PurposeNote = &purposeNote
	visit.Notes = &notes
	visit.Purposes = []domain.Purpose{{Name: "<i>Splicing</i>"}}
	tpl := domain.TransitionNotification(domain.VisitStatusApproved, false, visit.VisitID)

	_, _, htmlBody := domain.BuildEmail(visit, tpl)
	for _, raw := range []string{
		"PT <b>Bold</b> & Co", "<script>alert('purpose')</script>",
		"<img src=x onerror=alert(1)>", "<i>Splicing</i>",
	} {
		if strings.Contains(htmlBody, raw) {
			t.Errorf("HTML body contains unescaped %q", raw)
		}
	}
}

// TestBuildEmail_VisitorNamesCarryCompany proves the team row renders
// "Nama (Perusahaan)" when the visitor has a resolved company and the plain
// name otherwise, in BOTH bodies, skipping blank names.
func TestBuildEmail_VisitorNamesCarryCompany(t *testing.T) {
	visit := testVisit()
	visit.Visitors = []domain.Visitor{
		{Name: "Andi", VendorName: "PT Alpha"},
		{Name: "Budi"},
		{Name: " Citra ", VendorName: " PT Gamma "},
		{Name: "   "},
	}
	tpl := domain.TransitionNotification(domain.VisitStatusApproved, false, visit.VisitID)

	_, textBody, htmlBody := domain.BuildEmail(visit, tpl)
	want := "Andi (PT Alpha), Budi, Citra (PT Gamma)"
	if !strings.Contains(textBody, "Anggota tim: "+want) {
		t.Errorf("text team row = %q, want %q in:\n%s", "", want, textBody)
	}
	for _, frag := range []string{"Anggota tim", want} {
		if !strings.Contains(htmlBody, frag) {
			t.Errorf("HTML team row missing %q", frag)
		}
	}
	if strings.Contains(textBody, "( )") || strings.Contains(htmlBody, "( )") {
		t.Error("a member without company must render the plain name, never empty parentheses")
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
