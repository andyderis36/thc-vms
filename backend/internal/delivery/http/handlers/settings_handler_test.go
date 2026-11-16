package handlers_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/handlers"
	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/settings"
)

// fakeSettingsRepo adalah domain.SettingsRepository dalam memori untuk uji
// PUT matriks: Get mengembalikan nilai lama, Update mencatat auditEntry.
type fakeSettingsRepo struct {
	getRaw     []byte
	getVersion int
	lastKey    string
	lastValue  []byte
	lastVer    int
	lastEntry  domain.AuditEntry
	newVersion int
}

func (f *fakeSettingsRepo) Get(_ context.Context, key string) ([]byte, int, bool, error) {
	return f.getRaw, f.getVersion, true, nil
}

func (f *fakeSettingsRepo) Update(_ context.Context, key string, value []byte, expectedVersion int, updatedBy *domain.UUID, auditEntry domain.AuditEntry) (int, error) {
	f.lastKey = key
	f.lastValue = value
	f.lastVer = expectedVersion
	f.lastEntry = auditEntry
	return f.newVersion, nil
}

// vendorLegsWithoutSendPath memetakan sel vendor yang tidak punya kaki
// pengiriman: visit_requested tidak punya kaki vendor sama sekali, sedangkan
// check_in/check_out hanya kehilangan sel in_app.vendor - sel email.vendor-nya
// tetap hidup karena roster fan-out memails anggota roster.
var vendorLegsWithoutSendPath = map[domain.NotificationType]map[string]bool{
	domain.NotificationVisitRequested: {"in_app": true, "email": true},
	domain.NotificationVisitCheckIn:   {"in_app": true},
	domain.NotificationVisitCheckOut:  {"in_app": true},
}

// storedMatrix adalah matriks yang tersimpan setelah PUT pada uji audit:
// default all-Active dengan sel vendor tanpa kaki dimatikan.
func storedMatrix() domain.NotificationSettings {
	st := domain.DefaultNotificationSettings()
	for ev, cells := range vendorLegsWithoutSendPath {
		tg := st.Toggles[ev]
		if cells["in_app"] {
			tg.InApp.Vendor = false
		}
		if cells["email"] {
			tg.Email.Vendor = false
		}
		st.Toggles[ev] = tg
	}
	return st
}

// TestSettingsMatrix_ApplicableFlagsPinDeadLegs membuktikan GET/PUT memuat
// applicable per toggle: vendor requested mati di kedua kanal, check_in/
// check_out mati hanya di in_app (sel email.vendor punya kaki roster
// fan-out), rescheduled/reminder/cancelled/auto_cancelled semua hidup.
func TestSettingsMatrix_ApplicableFlagsPinDeadLegs(t *testing.T) {
	rawDef, err := json.Marshal(domain.DefaultNotificationSettings())
	if err != nil {
		t.Fatalf("marshal default: %v", err)
	}
	fake := &fakeSettingsRepo{getRaw: rawDef, getVersion: 3, newVersion: 4}
	svc := settings.NewService(fake)
	h := handlers.NewSettingsHandler(svc)

	engine := gin.New()
	engine.Use(withActor("super_admin", ""))
	engine.GET("/settings/notifications", h.Get)
	engine.PUT("/settings/notifications", h.Update)

	rec := serveJSON(engine, "GET", "/settings/notifications", "")
	mustStatus(t, rec, 200)
	env := mustSuccess(t, rec)
	var payload struct {
		Toggles []map[string]any `json:"toggles"`
		Version int               `json:"version"`
	}
	if err := json.Unmarshal(env.Data, &payload); err != nil {
		t.Fatalf("decode matrix: %v", err)
	}
	byEvent := map[string]map[string]any{}
	for _, m := range payload.Toggles {
		byEvent[m["event"].(string)] = m
	}
	for _, ev := range []string{"visit_requested", "visit_check_in", "visit_check_out"} {
		app, ok := byEvent[ev]["applicable"].(map[string]any)
		if !ok {
			t.Fatalf("%s applicable missing: %v", ev, byEvent[ev])
		}
		wantVendor := map[string]bool{"in_app": false, "email": false}
		if ev != "visit_requested" {
			wantVendor["email"] = true
		}
		for _, ch := range []string{"in_app", "email"} {
			cell, ok := app[ch].(map[string]any)
			if !ok {
				t.Fatalf("%s %s missing", ev, ch)
			}
			if cell["staff"] != true || cell["vendor"] != wantVendor[ch] {
				t.Fatalf("%s %s = %v, want {staff:true vendor:%v}", ev, ch, cell, wantVendor[ch])
			}
			// Sel tanpa kaki dipublikasikan OFF: nilai tersimpan yang ON
			// di sana adalah sakelar mati, jadi matriks melaporkan keadaan
			// efektif dan klien tidak pernah mengirim ulang sel tak berlaku ON.
			toggle, ok := byEvent[ev][ch].(map[string]any)
			if !ok {
				t.Fatalf("%s %s toggle missing", ev, ch)
			}
			if toggle["vendor"] != wantVendor[ch] {
				t.Fatalf("%s %s vendor = %v, want %v (effective state)", ev, ch, toggle["vendor"], wantVendor[ch])
			}
			if toggle["staff"] != true {
				t.Fatalf("%s %s staff = %v, want true", ev, ch, toggle["staff"])
			}
		}
	}
	for _, ev := range []string{"visit_rescheduled", "visit_reminder", "visit_cancelled", "visit_auto_cancelled"} {
		app, ok := byEvent[ev]["applicable"].(map[string]any)
		if !ok {
			t.Fatalf("%s applicable missing", ev)
		}
		for _, ch := range []string{"in_app", "email"} {
			cell := app[ch].(map[string]any)
			if cell["staff"] != true || cell["vendor"] != true {
				t.Fatalf("%s %s = %v, want all true", ev, ch, cell)
			}
		}
	}
	if byEvent["visit_auto_cancelled"]["mandatory"] != true {
		t.Fatalf("auto_cancelled mandatory = %v, want true", byEvent["visit_auto_cancelled"]["mandatory"])
	}
}

// TestSettingsPut_RejectsInapplicableEnable membuktikan PUT menolak
// pengaktifan sel inaplikabel dengan VALIDATION_ERROR tanpa menulis repo.
func TestSettingsPut_RejectsInapplicableEnable(t *testing.T) {
	rawDef, err := json.Marshal(domain.DefaultNotificationSettings())
	if err != nil {
		t.Fatalf("marshal default: %v", err)
	}
	fake := &fakeSettingsRepo{getRaw: rawDef, getVersion: 3, newVersion: 4}
	svc := settings.NewService(fake)
	h := handlers.NewSettingsHandler(svc)

	engine := gin.New()
	engine.Use(withActor("super_admin", ""))
	engine.PUT("/settings/notifications", h.Update)

	toggles := `"toggles":[{"event":"visit_requested","in_app":{"staff":true,"vendor":true},"email":{"staff":true,"vendor":false}}]`
	rec := serveJSON(engine, "PUT", "/settings/notifications", `{"version":3,`+toggles+`}`)
	mustStatus(t, rec, 422)
	if fake.lastValue != nil {
		t.Fatalf("repo write happened on inapplicable enable: %s", string(fake.lastValue))
	}
}

// TestSettingsPut_AuditCarriesActualOldNew membuktikan PUT /settings/
// notifications membaca nilai lama SEBELUM tulis dan menyimpan old/new aktual
// (bukan string kosong) ke baris audit, dengan kunci yang benar.
func TestSettingsPut_AuditCarriesActualOldNew(t *testing.T) {
	oldSt := domain.DefaultNotificationSettings()
	oldSt.Toggles[domain.NotificationVisitRequested] = domain.NotificationEventToggle{
		InApp: domain.NotificationChannelToggle{Staff: false, Vendor: false},
		Email: domain.NotificationChannelToggle{Staff: false, Vendor: false},
	}
	oldRaw, err := json.Marshal(oldSt)
	if err != nil {
		t.Fatalf("marshal old: %v", err)
	}
	fake := &fakeSettingsRepo{getRaw: oldRaw, getVersion: 3, newVersion: 4}
	svc := settings.NewService(fake)
	h := handlers.NewSettingsHandler(svc)

	engine := gin.New()
	engine.Use(withActor("super_admin", ""))
	engine.PUT("/settings/notifications", h.Update)

	toggles := `"toggles":[`
	events := []string{"visit_requested", "visit_approved", "visit_rejected", "visit_rescheduled", "visit_check_in", "visit_check_out", "visit_cancelled", "visit_auto_cancelled", "visit_reminder"}
	for i, ev := range events {
		if i > 0 {
			toggles += ","
		}
		// Sel vendor tanpa kaki harus tetap mati, kalau tidak PUT ditolak
		// sebagai inaplikabel.
		inAppVendor := "true"
		emailVendor := "true"
		if cells, ok := vendorLegsWithoutSendPath[domain.NotificationType(ev)]; ok {
			if cells["in_app"] {
				inAppVendor = "false"
			}
			if cells["email"] {
				emailVendor = "false"
			}
		}
		toggles += `{"event":"` + ev + `","in_app":{"staff":true,"vendor":` + inAppVendor + `},"email":{"staff":true,"vendor":` + emailVendor + `}}`
	}
	toggles += `]`
	rec := serveJSON(engine, "PUT", "/settings/notifications", `{"version":3,`+toggles+`}`)
	mustStatus(t, rec, 200)
	env := mustSuccess(t, rec)
	_ = env

	if fake.lastKey != domain.SettingsKeyNotifications {
		t.Fatalf("audit key = %q, want %q", fake.lastKey, domain.SettingsKeyNotifications)
	}
	if fake.lastVer != 3 {
		t.Fatalf("expectedVersion = %d, want 3", fake.lastVer)
	}
	meta := fake.lastEntry.Metadata
	if meta["key"] != domain.SettingsKeyNotifications {
		t.Fatalf("metadata key = %q, want notifications", meta["key"])
	}

	wantOld, err := json.Marshal(domain.LoadNotificationSettings(oldRaw, 3))
	if err != nil {
		t.Fatalf("marshal wantOld: %v", err)
	}
	if meta["old"] != string(wantOld) {
		t.Fatalf("metadata old = %s, want %s", meta["old"], string(wantOld))
	}

	wantNew, err := json.Marshal(storedMatrix())
	if err != nil {
		t.Fatalf("marshal wantNew: %v", err)
	}
	if meta["new"] != string(wantNew) {
		t.Fatalf("metadata new = %s, want %s", meta["new"], string(wantNew))
	}
	if fake.lastEntry.Action != domain.AuditActionSettingsUpdate || fake.lastEntry.Entity != domain.AuditEntitySettings {
		t.Fatalf("audit action/entity = %q/%q, want settings.update/settings",
			fake.lastEntry.Action, fake.lastEntry.Entity)
	}
}
