package domain_test

import (
	"encoding/json"
	"testing"

	"thc-vms/backend/internal/domain"
)

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
