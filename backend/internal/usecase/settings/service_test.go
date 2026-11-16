package settings

import (
	"context"
	"testing"

	"thc-vms/backend/internal/domain"
)

type stubSettingsRepo struct{}

func (stubSettingsRepo) Get(_ context.Context, _ string) ([]byte, int, bool, error) {
	return nil, 0, false, nil
}

func (stubSettingsRepo) Update(_ context.Context, _ string, _ []byte, _ int, _ *domain.UUID, _ domain.AuditEntry) (int, error) {
	return 1, nil
}

// TestService_UpdateRejectsDisablingAutoCancelled proves visit_auto_cancelled
// is locked like the other mandatory types: a PUT row switching any of its
// cells off fails validation before any repository write.
func TestService_UpdateRejectsDisablingAutoCancelled(t *testing.T) {
	svc := NewService(stubSettingsRepo{})
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
