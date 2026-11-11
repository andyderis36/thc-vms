package settings

import (
	"context"
	"encoding/json"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/visit"
)

// Actor is the authenticated caller (reuse visit.Actor).
type Actor = visit.Actor

// ToggleInput is one row of the PUT body.
type ToggleInput struct {
	Event string                      `json:"event"`
	InApp domain.NotificationChannelToggle `json:"in_app"`
	Email domain.NotificationChannelToggle `json:"email"`
}

// UpdateInput is the PUT body.
type UpdateInput struct {
	Toggles []ToggleInput `json:"toggles"`
	Version int           `json:"version"`
}

// Service is the settings usecase.
type Service struct {
	repo domain.SettingsRepository
}

// NewService wires the usecase to its repository port.
func NewService(repo domain.SettingsRepository) *Service {
	return &Service{repo: repo}
}

// Get returns the current notification settings.
func (s *Service) Get(ctx context.Context) (domain.NotificationSettings, error) {
	raw, version, found, err := s.repo.Get(ctx, domain.SettingsKeyNotifications)
	if err != nil {
		return domain.NotificationSettings{}, err
	}
	if !found {
		st := domain.DefaultNotificationSettings()
		st.Version = 1
		return st, nil
	}
	st := domain.ParseNotificationSettings(raw)
	st.Version = version
	return st, nil
}

// Update validates and persists the matrix.
func (s *Service) Update(ctx context.Context, actor Actor, in UpdateInput, auditEntry domain.AuditEntry) (domain.NotificationSettings, error) {
	known := map[domain.NotificationType]bool{}
	for _, t := range []domain.NotificationType{
		domain.NotificationVisitRequested, domain.NotificationVisitRescheduled, domain.NotificationVisitCheckIn,
		domain.NotificationVisitCheckOut, domain.NotificationVisitCancelled, domain.NotificationVisitApproved,
		domain.NotificationVisitRejected, domain.NotificationVisitReminder, domain.NotificationVisitAutoCancelled,
	} {
		known[t] = true
	}

	st := domain.DefaultNotificationSettings()
	st.Toggles = map[domain.NotificationType]domain.NotificationEventToggle{}

	for _, tg := range in.Toggles {
		nt := domain.NotificationType(tg.Event)
		if !known[nt] {
			return domain.NotificationSettings{}, domain.ValidationFailure("Tipe notifikasi tidak dikenal: " + tg.Event)
		}
		if domain.IsMandatoryNotification(nt) {
			if !tg.InApp.Staff || !tg.InApp.Vendor || !tg.Email.Staff || !tg.Email.Vendor {
				return domain.NotificationSettings{}, domain.ValidationFailure("Notifikasi wajib tidak dapat dinonaktifkan.")
			}
		}
		st.Toggles[nt] = domain.NotificationEventToggle{
			InApp:     tg.InApp,
			Email:     tg.Email,
			Mandatory: domain.IsMandatoryNotification(nt),
		}
	}
	// fill missing with defaults
	def := domain.DefaultNotificationSettings()
	for t, tg := range def.Toggles {
		if _, ok := st.Toggles[t]; !ok {
			st.Toggles[t] = tg
		}
	}

	raw, err := json.Marshal(st)
	if err != nil {
		return domain.NotificationSettings{}, err
	}
	if auditEntry.Metadata == nil {
		auditEntry.Metadata = map[string]string{}
	}
	auditEntry.Metadata["key"] = domain.SettingsKeyNotifications
	auditEntry.Metadata["new"] = string(raw)
	if auditEntry.Metadata["old"] == "" {
		if oldRaw, _, found, err := s.repo.Get(ctx, domain.SettingsKeyNotifications); err == nil && found {
			auditEntry.Metadata["old"] = string(oldRaw)
		}
	}
	newVersion, err := s.repo.Update(ctx, domain.SettingsKeyNotifications, raw, in.Version, &actor.ID, auditEntry)
	if err != nil {
		return domain.NotificationSettings{}, err
	}
	st.Version = newVersion
	return st, nil
}
