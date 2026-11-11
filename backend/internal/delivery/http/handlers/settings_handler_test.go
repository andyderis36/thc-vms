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

// TestSettingsPut_AuditCarriesActualOldNew membuktikan PUT /settings/
// notifications membaca nilai lama SEBELUM tulis dan menyimpan old/new aktual
// (bukan string kosong) ke baris audit, dengan key yang benar.
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
		toggles += `{"event":"` + ev + `","in_app":{"staff":true,"vendor":true},"email":{"staff":true,"vendor":true}}`
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

	wantNew, err := json.Marshal(domain.DefaultNotificationSettings())
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
