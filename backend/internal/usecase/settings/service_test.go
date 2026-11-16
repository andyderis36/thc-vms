package settings

import (
	"context"
	"encoding/json"
	"testing"

	"thc-vms/backend/internal/domain"
)

type stubSettingsRepo struct {
	lastValue []byte
}

func (s *stubSettingsRepo) Get(_ context.Context, _ string) ([]byte, int, bool, error) {
	return nil, 0, false, nil
}

func (s *stubSettingsRepo) Update(_ context.Context, _ string, value []byte, _ int, _ *domain.UUID, _ domain.AuditEntry) (int, error) {
	s.lastValue = value
	return 1, nil
}

// TestService_UpdateRejectsEnablingInapplicable proves enabling a vendor leg
// with no backend leg fails validation, while leaving it off passes.
func TestService_UpdateRejectsEnablingInapplicable(t *testing.T) {
	svc := NewService(&stubSettingsRepo{})
	on := domain.NotificationChannelToggle{Staff: true, Vendor: true}
	off := domain.NotificationChannelToggle{Staff: false, Vendor: false}
	staffOnly := domain.NotificationChannelToggle{Staff: true, Vendor: false}
	for _, ev := range []string{
		string(domain.NotificationVisitRequested),
		string(domain.NotificationVisitCheckIn),
		string(domain.NotificationVisitCheckOut),
	} {
		_, err := svc.Update(context.Background(), Actor{}, UpdateInput{
			Toggles: []ToggleInput{{Event: ev, InApp: on, Email: off}},
		}, domain.AuditEntry{})
		if err == nil {
			t.Fatalf("Update enabling %s in_app.vendor succeeded, want inapplicable rejection", ev)
		}
		_, err = svc.Update(context.Background(), Actor{}, UpdateInput{
			Toggles: []ToggleInput{{Event: ev, InApp: staffOnly, Email: staffOnly}},
		}, domain.AuditEntry{})
		if err != nil {
			t.Fatalf("Update %s staff-only unexpectedly failed: %v", ev, err)
		}
	}
	_, err := svc.Update(context.Background(), Actor{}, UpdateInput{
		Toggles: []ToggleInput{{Event: string(domain.NotificationVisitRescheduled), InApp: on, Email: on}},
	}, domain.AuditEntry{})
	if err != nil {
		t.Fatalf("Update rescheduled all-on unexpectedly failed: %v", err)
	}
}

// TestService_UpdateRejectsDisablingAutoCancelled proves visit_auto_cancelled
// is locked like the other mandatory types: a PUT row switching any of its
// cells off fails validation before any repository write.
func TestService_UpdateRejectsDisablingAutoCancelled(t *testing.T) {
	svc := NewService(&stubSettingsRepo{})
	off := domain.NotificationChannelToggle{Staff: false, Vendor: false}
	on := domain.NotificationChannelToggle{Staff: true, Vendor: true}
	_, err := svc.Update(context.Background(), Actor{}, UpdateInput{
		Toggles: []ToggleInput{
			{Event: string(domain.NotificationVisitAutoCancelled), InApp: off, Email: on},
		},
	}, domain.AuditEntry{})
	if err == nil {
		t.Fatal("Update disabling auto_cancelled in_app succeeded, want a mandatory validation failure")
	}
	_, err = svc.Update(context.Background(), Actor{}, UpdateInput{
		Toggles: []ToggleInput{
			{Event: string(domain.NotificationVisitAutoCancelled), InApp: on, Email: off},
		},
	}, domain.AuditEntry{})
	if err == nil {
		t.Fatal("Update disabling auto_cancelled email succeeded, want a mandatory validation failure")
	}
}

// TestService_UpdateFillsMissingEventsMaskedByApplicability proves the
// default-filled events keep the all-ON default only in the cells that have a
// send leg: a cell without a leg is stored OFF, so the storage can never hold
// ON in a cell the backend never delivers.
func TestService_UpdateFillsMissingEventsMaskedByApplicability(t *testing.T) {
	repo := &stubSettingsRepo{}
	svc := NewService(repo)
	staffOnly := domain.NotificationChannelToggle{Staff: true, Vendor: false}
	_, err := svc.Update(context.Background(), Actor{}, UpdateInput{
		Toggles: []ToggleInput{{
			Event: string(domain.NotificationVisitRescheduled),
			InApp: staffOnly,
			Email: staffOnly,
		}},
	}, domain.AuditEntry{})
	if err != nil {
		t.Fatalf("Update partial unexpectedly failed: %v", err)
	}
	stored := map[string]domain.NotificationEventToggle{}
	if err := json.Unmarshal(repo.lastValue, &stored); err != nil {
		t.Fatalf("decode stored matrix: %v", err)
	}

	// check_in terisi default: in_app.vendor tidak punya kaki (anggota
	// roster tidak pernah punya baris in_app) sehingga tersimpan OFF,
	// sedangkan email.vendor punya kaki roster fan-out sehingga tetap ON.
	checkIn, ok := stored[string(domain.NotificationVisitCheckIn)]
	if !ok {
		t.Fatalf("check_in tidak tersimpan: %v", stored)
	}
	if checkIn.InApp.Vendor {
		t.Fatalf("check_in in_app.vendor = true, want false (no leg): %+v", checkIn.InApp)
	}
	if !checkIn.InApp.Staff || !checkIn.Email.Staff {
		t.Fatalf("check_in staff cells = %+v, want staff ON", checkIn)
	}
	if !checkIn.Email.Vendor {
		t.Fatalf("check_in email.vendor = false, want true (roster fan-out leg): %+v", checkIn.Email)
	}

	// requested terisi default tanpa kaki vendor sama sekali.
	requested, ok := stored[string(domain.NotificationVisitRequested)]
	if !ok {
		t.Fatalf("requested tidak tersimpan: %v", stored)
	}
	if requested.InApp.Vendor || requested.Email.Vendor {
		t.Fatalf("requested vendor cells = %+v/%+v, want both false (no leg)", requested.InApp, requested.Email)
	}
	if !requested.InApp.Staff || !requested.Email.Staff {
		t.Fatalf("requested staff cells = %+v, want staff ON", requested)
	}

	// Baris yang dikirimskan eksplisit tersimpan apa adanya.
	rescheduled, ok := stored[string(domain.NotificationVisitRescheduled)]
	if !ok {
		t.Fatalf("rescheduled tidak tersimpan: %v", stored)
	}
	if rescheduled.InApp != staffOnly || rescheduled.Email != staffOnly {
		t.Fatalf("rescheduled stored = %+v, want the sent row verbatim", rescheduled)
	}
}
