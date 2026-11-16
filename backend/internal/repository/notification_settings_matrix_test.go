package repository

// Bukti Slice A — matriks notifikasi per peristiwa:
//
//  1. Tipe wajib (approved/rejected/cancelled) yang tersimpan Off tetap emit
//     (baris in_app) DAN tetap enqueue (email): fail-closed ke Active.
//  2. Tipe non-mandatory yang Off tidak emit di kedua kanal: 0 baris in_app
//     dan 0 email.
//  3. Create memakai snapshot settingsLoader (bukan default hardcoded):
//     visit_requested yang Off menghentikan emit saat pembuatan.
//  4. PUT menulis tepat 1 baris audit berisi {key, old, new}.

import (
	"context"
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/repository/db"
)

// fixedSettingsLoader adalah domain.SettingsLoader statis untuk uji.
type fixedSettingsLoader struct {
	snap domain.NotificationSettings
	err  error
}

func (f fixedSettingsLoader) LoadNotificationSettings(ctx context.Context) (domain.NotificationSettings, error) {
	_ = ctx
	if f.err != nil {
		return domain.DefaultNotificationSettings(), f.err
	}
	return f.snap, nil
}

// allOffSettings mematikan SEMUA sel matriks (in_app + email, staf + vendor).
// Tipe wajib harus tetap menyala melaluinya (fail-closed).
func allOffSettings() domain.NotificationSettings {
	snap := domain.DefaultNotificationSettings()
	for t, tg := range snap.Toggles {
		tg.InApp = domain.NotificationChannelToggle{Staff: false, Vendor: false}
		tg.Email = domain.NotificationChannelToggle{Staff: false, Vendor: false}
		snap.Toggles[t] = tg
	}
	return snap
}

// countTypeForVisit menghitung notifikasi satu pengguna untuk satu visit.
func countTypeForVisit(t *testing.T, notifs domain.NotificationRepository, ctx context.Context, user, visit domain.UUID, typ domain.NotificationType) int {
	t.Helper()
	items, _, _, err := notifs.List(ctx, domain.NotificationFilter{UserID: user, Page: 1, Limit: 100})
	if err != nil {
		t.Fatalf("list notifications: %v", err)
	}
	n := 0
	for _, it := range items {
		if it.Type == typ && it.VisitRequestID == visit {
			n++
		}
	}
	return n
}

// TestSettingsMatrix_MandatoryStoredOffStillEmitsAndEnqueues membuktikan tipe
// wajib yang tersimpan Off tetap emit (1 baris in_app) dan tetap enqueue
// (1 email ke vendor): IsMandatory fail-closed ke Active.
func TestSettingsMatrix_MandatoryStoredOffStillEmitsAndEnqueues(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	notifs := NewNotificationRepository(pool)

	loc := seedLocation(t, pool, "Cabang Wajib", "cabang")
	vendor := seedUser(t, pool, seedUserParams{Name: "Vendor Wajib", Email: "wajib@vendor.test", Role: "vendor", Type: "external"})
	visit := seedVisit(t, pool, seedVisitParams{
		Code: "VST-0000000601", VendorUser: vendor, Location: loc,
		Start: time.Now().Add(time.Hour), End: time.Now().Add(2 * time.Hour),
		Status: domain.VisitStatusRequested,
	})

	snap := allOffSettings()
	if !snap.IsInAppEnabled(domain.NotificationVisitApproved, domain.NotificationAudienceVendor) {
		t.Fatal("mandatory approved harus in_app-Active walau tersimpan Off")
	}
	if !domain.EmailAllowedWithSettings(domain.NotificationVisitApproved, snap) {
		t.Fatal("mandatory approved harus email-Active walau tersimpan Off")
	}

	visitUUID, err := fromDomainUUID(visit)
	if err != nil {
		t.Fatalf("parse visit id: %v", err)
	}
	locUUID, err := fromDomainUUID(loc)
	if err != nil {
		t.Fatalf("parse location id: %v", err)
	}
	vendorUUID, err := fromDomainUUID(vendor)
	if err != nil {
		t.Fatalf("parse vendor id: %v", err)
	}
	tpl := &domain.NotificationTemplate{
		Type: domain.NotificationVisitApproved, Title: "Kunjungan Disetujui",
		Message: "Permintaan VST-0000000601 telah disetujui.", Audience: domain.NotificationAudienceVendor,
	}
	if err := emit(ctx, db.New(pool), tpl, visitUUID, locUUID, vendorUUID, time.Now(), snap); err != nil {
		t.Fatalf("emit mandatory-Off: %v", err)
	}
	if n := countTypeForVisit(t, notifs, ctx, vendor, visit, domain.NotificationVisitApproved); n != 1 {
		t.Fatalf("vendor visit_approved rows = %d, want 1 (mandatory Off tetap emit)", n)
	}

	mailer := &domain.FakeMailer{}
	enqueueEmail(ctx, mailer, db.New(pool),
		domain.VisitRequest{VisitID: "VST-0000000601", StartDate: time.Now().Add(time.Hour), EndDate: time.Now().Add(2 * time.Hour)},
		tpl, locUUID, vendorUUID, "", snap, domain.NotificationAudienceVendor)
	if len(mailer.Calls) != 1 {
		t.Fatalf("email calls = %d, want 1 (mandatory Off tetap enqueue)", len(mailer.Calls))
	}
	if len(mailer.Calls[0].To) != 1 || mailer.Calls[0].To[0] != "wajib@vendor.test" {
		t.Fatalf("email to = %v, want [wajib@vendor.test]", mailer.Calls[0].To)
	}
}

// TestSettingsMatrix_AutoCancelledStoredOffStillMandatory membuktikan
// visit_auto_cancelled yang tersimpan Off tetap emit dan enqueue: R1/R2
// adalah tipe wajib (fail-closed ke Active), jadi penolakan PUT dan bypass
// pengiriman berlaku dua arah kanal.
func TestSettingsMatrix_AutoCancelledStoredOffStillMandatory(t *testing.T) {
	snap := allOffSettings()
	if !snap.IsInAppEnabled(domain.NotificationVisitAutoCancelled, domain.NotificationAudienceStaff) {
		t.Fatal("auto_cancelled staff harus in_app-Active walau tersimpan Off")
	}
	if !snap.IsInAppEnabled(domain.NotificationVisitAutoCancelled, domain.NotificationAudienceVendor) {
		t.Fatal("auto_cancelled vendor harus in_app-Active walau tersimpan Off")
	}
	if !domain.EmailAllowedWithSettings(domain.NotificationVisitAutoCancelled, snap) {
		t.Fatal("auto_cancelled harus email-Active walau tersimpan Off")
	}
	if !snap.IsEmailEnabled(domain.NotificationVisitAutoCancelled, domain.NotificationAudienceStaff) {
		t.Fatal("auto_cancelled staff email harus Active walau tersimpan Off")
	}
	if !snap.IsEmailEnabled(domain.NotificationVisitAutoCancelled, domain.NotificationAudienceVendor) {
		t.Fatal("auto_cancelled vendor email harus Active walau tersimpan Off")
	}
}

// TestSettingsMatrix_NonMandatoryOffEmitsNothing membuktikan tipe
// non-mandatory yang Off tidak emit di kedua kanal: 0 baris in_app (kedua
// audiens) dan 0 email.
func TestSettingsMatrix_NonMandatoryOffEmitsNothing(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	notifs := NewNotificationRepository(pool)

	loc := seedLocation(t, pool, "Cabang Sunyi", "cabang")
	vendor := seedUser(t, pool, seedUserParams{Name: "Vendor Sunyi", Email: "sunyi@vendor.test", Role: "vendor", Type: "external"})
	admin := seedUser(t, pool, seedUserParams{Name: "Admin Sunyi", Email: "admin.sunyi@thc.test", Role: "admin", Location: loc, Type: "internal"})
	superAdmin := seedUser(t, pool, seedUserParams{Name: "Super Sunyi", Email: "super.sunyi@thc.test", Role: "super_admin", Type: "internal"})
	visit := seedVisit(t, pool, seedVisitParams{
		Code: "VST-0000000602", VendorUser: vendor, Location: loc,
		Start: time.Now().Add(time.Hour), End: time.Now().Add(2 * time.Hour),
		Status: domain.VisitStatusRequested,
	})

	snap := allOffSettings()
	tpl := domain.TransitionNotification(domain.VisitStatusRescheduled, false, "VST-0000000602", "")
	if tpl == nil {
		t.Fatal("rescheduled template must not be nil")
	}
	if snap.IsInAppEnabled(tpl.Type, tpl.Audience) {
		t.Fatal("non-mandatory rescheduled harus in_app-Mati saat Off")
	}
	if domain.EmailAllowedWithSettings(tpl.Type, snap) {
		t.Fatal("non-mandatory rescheduled harus email-Mati saat Off")
	}

	visitUUID, err := fromDomainUUID(visit)
	if err != nil {
		t.Fatalf("parse visit id: %v", err)
	}
	locUUID, err := fromDomainUUID(loc)
	if err != nil {
		t.Fatalf("parse location id: %v", err)
	}
	vendorUUID, err := fromDomainUUID(vendor)
	if err != nil {
		t.Fatalf("parse vendor id: %v", err)
	}
	if err := emit(ctx, db.New(pool), tpl, visitUUID, locUUID, vendorUUID, time.Now(), snap); err != nil {
		t.Fatalf("emit non-mandatory-Off: %v", err)
	}
	for _, u := range []domain.UUID{admin, superAdmin} {
		if n := countTypeForVisit(t, notifs, ctx, u, visit, domain.NotificationVisitRescheduled); n != 0 {
			t.Fatalf("staff visit_rescheduled rows = %d, want 0 (non-mandatory Off)", n)
		}
	}

	mailer := &domain.FakeMailer{}
	enqueueEmail(ctx, mailer, db.New(pool),
		domain.VisitRequest{VisitID: "VST-0000000602", StartDate: time.Now().Add(time.Hour), EndDate: time.Now().Add(2 * time.Hour)},
		tpl, locUUID, vendorUUID, "", snap, domain.NotificationAudienceStaff, domain.NotificationAudienceVendor)
	if len(mailer.Calls) != 0 {
		t.Fatalf("email calls = %d, want 0 (non-mandatory Off)", len(mailer.Calls))
	}
}

// TestSettingsMatrix_CreateRespectsStoredOff membuktikan Create memakai
// snapshot settingsLoader: visit_requested yang Off menghentikan emit saat
// pembuatan, sedangkan tanpa loader (default) baris tetap tertulis.
func TestSettingsMatrix_CreateRespectsStoredOff(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	notifs := NewNotificationRepository(pool)

	loc := seedLocation(t, pool, "Cabang Buat", "cabang")
	vendor := seedUser(t, pool, seedUserParams{Name: "Vendor Buat", Email: "buat@vendor.test", Role: "vendor", Type: "external"})
	admin := seedUser(t, pool, seedUserParams{Name: "Admin Buat", Email: "admin.buat@thc.test", Role: "admin", Location: loc, Type: "internal"})

	newReq := func() (domain.VisitRequest, []domain.Visitor, []domain.UUID) {
		start := time.Now().UTC().Add(48 * time.Hour).Truncate(time.Second)
		return domain.VisitRequest{
			VendorUserID: vendor, LocationID: loc,
			StartDate: start, EndDate: start.Add(4 * time.Hour), IsNDAAccepted: true,
		}, nil, nil
	}

	offReq, offVis, offPur := newReq()
	offMailer := &domain.FakeMailer{}
	offRepos := NewVisitRepository(pool).WithMailer(offMailer).WithSettings(fixedSettingsLoader{snap: allOffSettings()})
	offCreated, err := offRepos.Create(ctx, offReq, offVis, offPur)
	if err != nil {
		t.Fatalf("Create dengan stored-Off: %v", err)
	}
	if n := countTypeForVisit(t, notifs, ctx, admin, offCreated.ID, domain.NotificationVisitRequested); n != 0 {
		t.Fatalf("visit_requested rows = %d, want 0 (toggle Off harus menghentikan emit Create)", n)
	}
	if len(offMailer.Calls) != 0 {
		t.Fatalf("email calls dengan stored-Off = %d, want 0 (toggle Off harus menekan email Create non-mandatory)", len(offMailer.Calls))
	}

	defReq, defVis, defPur := newReq()
	defCreated, err := NewVisitRepository(pool).Create(ctx, defReq, defVis, defPur)
	if err != nil {
		t.Fatalf("Create default: %v", err)
	}
	if n := countTypeForVisit(t, notifs, ctx, admin, defCreated.ID, domain.NotificationVisitRequested); n != 1 {
		t.Fatalf("visit_requested rows = %d, want 1 (default tetap emit)", n)
	}
}

// TestNotification_RequestedInAppIsAdminOnly membuktikan visit_requested
// in_app hanya menjangkau super_admin + admin cabang (tanpa security),
// sementara tipe staff lain (rescheduled) tetap menjangkau security.
func TestNotification_RequestedInAppIsAdminOnly(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	notifs := NewNotificationRepository(pool)

	loc := seedLocation(t, pool, "Cabang Minta", "cabang")
	vendor := seedUser(t, pool, seedUserParams{Name: "Vendor Minta", Email: "minta@vendor.test", Role: "vendor", Type: "external"})
	superAdmin := seedUser(t, pool, seedUserParams{Name: "Super Minta", Email: "super.minta@thc.test", Role: "super_admin", Type: "internal"})
	admin := seedUser(t, pool, seedUserParams{Name: "Admin Minta", Email: "admin.minta@thc.test", Role: "admin", Location: loc, Type: "internal"})
	security := seedUser(t, pool, seedUserParams{Name: "Sec Minta", Email: "sec.minta@thc.test", Role: "security", Location: loc, Type: "internal"})
	visit := seedVisit(t, pool, seedVisitParams{
		Code: "VST-0000000701", VendorUser: vendor, Location: loc,
		Start: time.Now().Add(time.Hour), End: time.Now().Add(2 * time.Hour),
		Status: domain.VisitStatusRequested,
	})

	snap := domain.DefaultNotificationSettings()
	visitUUID, err := fromDomainUUID(visit)
	if err != nil {
		t.Fatalf("parse visit id: %v", err)
	}
	locUUID, err := fromDomainUUID(loc)
	if err != nil {
		t.Fatalf("parse location id: %v", err)
	}
	vendorUUID, err := fromDomainUUID(vendor)
	if err != nil {
		t.Fatalf("parse vendor id: %v", err)
	}
	if err := emit(ctx, db.New(pool), domain.CreatedNotification("VST-0000000701"), visitUUID, locUUID, vendorUUID, time.Now(), snap); err != nil {
		t.Fatalf("emit requested: %v", err)
	}
	if n := countTypeForVisit(t, notifs, ctx, superAdmin, visit, domain.NotificationVisitRequested); n != 1 {
		t.Fatalf("super_admin requested rows = %d, want 1", n)
	}
	if n := countTypeForVisit(t, notifs, ctx, admin, visit, domain.NotificationVisitRequested); n != 1 {
		t.Fatalf("admin requested rows = %d, want 1", n)
	}
	if n := countTypeForVisit(t, notifs, ctx, security, visit, domain.NotificationVisitRequested); n != 0 {
		t.Fatalf("security requested rows = %d, want 0 (admin-only)", n)
	}

	resched := domain.TransitionNotification(domain.VisitStatusRescheduled, false, "VST-0000000701", "")
	if resched == nil {
		t.Fatal("rescheduled template must not be nil")
	}
	if err := emit(ctx, db.New(pool), resched, visitUUID, locUUID, vendorUUID, time.Now(), snap); err != nil {
		t.Fatalf("emit rescheduled: %v", err)
	}
	if n := countTypeForVisit(t, notifs, ctx, security, visit, domain.NotificationVisitRescheduled); n != 1 {
		t.Fatalf("security rescheduled rows = %d, want 1 (other types unchanged)", n)
	}
}

// TestSettings_PutWritesSingleAuditRow membuktikan PUT (via
// settingsRepository.Update seperti yang dipakai usecase) menulis tepat 1
// baris audit berisi {key, old, new} aktual.
func TestSettings_PutWritesSingleAuditRow(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)

	actor := seedUser(t, pool, seedUserParams{Name: "Super Audit", Email: "super.audit@thc.test", Role: "super_admin", Type: "internal"})
	repo := NewSettingsRepository(pool)
	audits := NewAuditRepository(pool)

	oldRaw := `{"visit_requested":{"in_app":{"staff":false,"vendor":false},"email":{"staff":false,"vendor":false}}}`
	newRaw := `{"visit_requested":{"in_app":{"staff":true,"vendor":true},"email":{"staff":true,"vendor":true}}}`
	if _, err := repo.Update(ctx, domain.SettingsKeyNotifications, []byte(newRaw), 0, &actor, domain.AuditEntry{
		ActorID: &actor, Action: domain.AuditActionSettingsUpdate, Entity: domain.AuditEntitySettings,
		Metadata: map[string]string{"key": domain.SettingsKeyNotifications, "old": oldRaw, "new": newRaw},
	}); err != nil {
		t.Fatalf("settings Update: %v", err)
	}

	items, total, err := audits.List(ctx, domain.AuditFilter{Action: domain.AuditActionSettingsUpdate})
	if err != nil {
		t.Fatalf("list audit: %v", err)
	}
	if total != 1 || len(items) != 1 {
		t.Fatalf("audit rows = %d items %d, want tepat 1", len(items), total)
	}
	got := items[0].Metadata
	if got["key"] != domain.SettingsKeyNotifications || got["old"] != oldRaw || got["new"] != newRaw {
		t.Fatalf("audit metadata = %v, want {key,old,new} aktual", got)
	}
	if items[0].UserID == nil || *items[0].UserID != actor {
		t.Fatalf("audit actor = %v, want %v", items[0].UserID, actor)
	}
}
