package domain_test

import (
	"encoding/json"
	"testing"

	"thc-vms/backend/internal/domain"
)

// TestNotificationApplicabilityFor_PinsDeadLegs mengunci sel mati yang
// editable: vendor in_app untuk requested/check_in/check_out tidak berlaku
// (anggota roster tidak pernah punya baris in_app), dan email.vendor untuk
// requested juga tidak berlaku (enqueueCreateEmail tidak punya loop roster).
func TestNotificationApplicabilityFor_PinsDeadLegs(t *testing.T) {
	inAppStaffOnly := []domain.NotificationType{
		domain.NotificationVisitRequested, domain.NotificationVisitCheckIn, domain.NotificationVisitCheckOut,
	}
	for _, typ := range inAppStaffOnly {
		got := domain.NotificationApplicabilityFor(typ)
		if !got.InApp.Staff || !got.Email.Staff {
			t.Fatalf("%s staff legs = %+v, want true", string(typ), got)
		}
		if got.InApp.Vendor {
			t.Fatalf("%s in_app vendor leg = %+v, want false (no vendor in_app row)", string(typ), got)
		}
	}
	requested := domain.NotificationApplicabilityFor(domain.NotificationVisitRequested)
	if requested.Email.Vendor {
		t.Fatalf("requested email vendor leg = %+v, want false (enqueueCreateEmail has no roster loop)", requested)
	}
	allOn := []domain.NotificationType{
		domain.NotificationVisitRescheduled, domain.NotificationVisitReminder,
		domain.NotificationVisitCancelled, domain.NotificationVisitAutoCancelled,
		domain.NotificationVisitApproved, domain.NotificationVisitRejected,
	}
	for _, typ := range allOn {
		got := domain.NotificationApplicabilityFor(typ)
		if !got.InApp.Staff || !got.InApp.Vendor || !got.Email.Staff || !got.Email.Vendor {
			t.Fatalf("%s applicable = %+v, want all true", string(typ), got)
		}
	}
}

// TestNotificationApplicabilityFor_RosterFanOutOpensEmailVendorOnly mengunci
// kaki roster fan-out: email.vendor berlaku untuk check_in/check_out karena
// enqueueEmail memails anggota roster yang punya email, sementara in_app.vendor
// tetap mati (anggota roster tidak pernah punya baris in_app). Sel email.vendor
// yang berlaku berarti Allows harus menerima sel itu dinyalakan.
func TestNotificationApplicabilityFor_RosterFanOutOpensEmailVendorOnly(t *testing.T) {
	staffOnly := domain.NotificationChannelToggle{Staff: true, Vendor: false}
	allOn := domain.NotificationChannelToggle{Staff: true, Vendor: true}
	for _, typ := range []domain.NotificationType{domain.NotificationVisitCheckIn, domain.NotificationVisitCheckOut} {
		got := domain.NotificationApplicabilityFor(typ)
		if !got.Email.Vendor {
			t.Fatalf("%s email vendor leg = %+v, want true (roster fan-out)", string(typ), got)
		}
		if got.InApp.Vendor {
			t.Fatalf("%s in_app vendor leg = %+v, want false (no vendor in_app row)", string(typ), got)
		}
		if !got.Allows(staffOnly, allOn) {
			t.Fatalf("%s Allows must accept the roster email leg on: %+v", string(typ), got)
		}
	}
}

// TestNotificationApplicabilityFor_DerivedFromTemplateAudiences mengunci
// aturan penurunan: applicability = himpunan audiens dari template yang
// DIKIRIM path pengiriman untuk tipe itu (bukan daftar event terpisah),
// ditambah kaki roster fan-out pada kanal email saja.
// Daftar template di bawah adalah enumerasi independen dari template yang
// dipakai repository.Create/Reschedule/UpdateStatus dan worker R4, sehingga
// sel yang salah di tabel kaki akan ketahuan.
func TestNotificationApplicabilityFor_DerivedFromTemplateAudiences(t *testing.T) {
	cases := []struct {
		typ       domain.NotificationType
		templates []*domain.NotificationTemplate
		// rosterEmail marks the types whose email send path also mails the
		// visit roster members (repository/email_enqueue.go:282).
		rosterEmail bool
	}{
		{domain.NotificationVisitRequested, []*domain.NotificationTemplate{
			domain.CreatedNotification("VST-0000000001"),
		}, false},
		{domain.NotificationVisitRescheduled, []*domain.NotificationTemplate{
			domain.TransitionNotification(domain.VisitStatusRescheduled, false, "VST-0000000001", ""),
			domain.RescheduledVendorNotification("VST-0000000001", ""),
		}, true},
		{domain.NotificationVisitCheckIn, []*domain.NotificationTemplate{
			domain.TransitionNotification(domain.VisitStatusVisiting, false, "VST-0000000001", ""),
		}, true},
		{domain.NotificationVisitCheckOut, []*domain.NotificationTemplate{
			domain.TransitionNotification(domain.VisitStatusCompleted, false, "VST-0000000001", ""),
		}, true},
		{domain.NotificationVisitReminder, []*domain.NotificationTemplate{
			domain.ReminderNotification("VST-0000000001"),
			domain.ReminderStaffNotification("VST-0000000001"),
		}, true},
	}
	for _, c := range cases {
		wantStaff, wantVendor := false, false
		for _, tpl := range c.templates {
			if tpl == nil {
				t.Fatalf("%s template list holds a nil template", string(c.typ))
			}
			switch tpl.Audience {
			case domain.NotificationAudienceStaff:
				wantStaff = true
			case domain.NotificationAudienceVendor:
				wantVendor = true
			default:
				t.Fatalf("%s template audience = %q, want staff atau vendor", string(c.typ), tpl.Audience)
			}
		}
		got := domain.NotificationApplicabilityFor(c.typ)
		if got.InApp.Staff != wantStaff || got.InApp.Vendor != wantVendor {
			t.Fatalf("%s in_app applicable = %+v, want staff=%v vendor=%v", string(c.typ), got.InApp, wantStaff, wantVendor)
		}
		if got.Email.Staff != wantStaff {
			t.Fatalf("%s email staff applicable = %+v, want %v", string(c.typ), got.Email, wantStaff)
		}
		wantEmailVendor := wantVendor || c.rosterEmail
		if got.Email.Vendor != wantEmailVendor {
			t.Fatalf("%s email vendor applicable = %+v, want %v (template vendor=%v roster=%v)",
				string(c.typ), got.Email, wantEmailVendor, wantVendor, c.rosterEmail)
		}
	}
}

// TestNotificationApplicability_AllowsOnlyEnabledCellsWithinLegs mengunci
// aturan Allows: sel yang dinyalakan harus punya kaki; sel yang dimatikan
// bebas dimatikan walau tidak punya kaki.
func TestNotificationApplicability_AllowsOnlyEnabledCellsWithinLegs(t *testing.T) {
	staffOnly := domain.NotificationApplicabilityFor(domain.NotificationVisitRequested)
	on := domain.NotificationChannelToggle{Staff: true, Vendor: true}
	off := domain.NotificationChannelToggle{Staff: false, Vendor: false}
	if staffOnly.Allows(on, on) {
		t.Fatal("requested vendor leg tidak punya kaki, harus ditolak")
	}
	if !staffOnly.Allows(off, off) {
		t.Fatal("requested yang dimatikan semua harus diterima")
	}
	if !staffOnly.Allows(domain.NotificationChannelToggle{Staff: true, Vendor: false}, off) {
		t.Fatal("requested sel staf saja harus diterima")
	}
	both := domain.NotificationApplicabilityFor(domain.NotificationVisitRescheduled)
	if !both.Allows(on, on) {
		t.Fatal("rescheduled punya kaki staf+vendor, semua sel harus diterima")
	}
}

// TestDefaultNotificationSettings_GoldenAllActive mengunci default hari ini:
// 9 peristiwa, SEMUA kanal + audiens Active, dan penanda mandatory persis
// IsMandatoryNotification. Perubahan default yang disengaja harus memperbarui
// golden ini secara eksplisit.
func TestDefaultNotificationSettings_GoldenAllActive(t *testing.T) {
	st := domain.DefaultNotificationSettings()
	all := []domain.NotificationType{
		domain.NotificationVisitRequested, domain.NotificationVisitRescheduled,
		domain.NotificationVisitCheckIn, domain.NotificationVisitCheckOut,
		domain.NotificationVisitCancelled, domain.NotificationVisitApproved,
		domain.NotificationVisitRejected, domain.NotificationVisitReminder,
		domain.NotificationVisitAutoCancelled,
	}
	if len(st.Toggles) != len(all) {
		t.Fatalf("toggles = %d, want %d", len(st.Toggles), len(all))
	}
	for _, typ := range all {
		tg, ok := st.Toggles[typ]
		if !ok {
			t.Fatalf("toggle %q hilang dari default", string(typ))
		}
		if !tg.InApp.Staff || !tg.InApp.Vendor || !tg.Email.Staff || !tg.Email.Vendor {
			t.Fatalf("toggle %q = %+v, want semua Active", string(typ), tg)
		}
		if tg.Mandatory != domain.IsMandatoryNotification(typ) {
			t.Fatalf("toggle %q mandatory = %v, want %v", string(typ), tg.Mandatory, domain.IsMandatoryNotification(typ))
		}
	}

	raw, err := json.Marshal(st)
	if err != nil {
		t.Fatalf("marshal default: %v", err)
	}
	var back domain.NotificationSettings
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatalf("unmarshal golden: %v", err)
	}
	if len(back.Toggles) != len(all) {
		t.Fatalf("golden round-trip toggles = %d, want %d", len(back.Toggles), len(all))
	}
	for _, typ := range all {
		got, ok := back.Toggles[typ]
		if !ok {
			t.Fatalf("golden %q hilang setelah round-trip", string(typ))
		}
		if !got.InApp.Staff || !got.InApp.Vendor || !got.Email.Staff || !got.Email.Vendor {
			t.Fatalf("golden %q = %+v, want semua Active", string(typ), got)
		}
	}
}
