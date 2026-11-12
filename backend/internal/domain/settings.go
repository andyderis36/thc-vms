package domain

import (
	"context"
	"encoding/json"
	"log/slog"
)

// SettingsKeyNotifications is the app_settings key holding the notification
// matrix.
const SettingsKeyNotifications = "notifications"

// MandatoryNotificationTypes are the notification types that can never be
// turned off: they are locked to Active in the matrix and IsEmailEnabled /
// IsInAppEnabled always report true for them, even when a stored row says Off.
// Vendor-registration approve/reject mails live in the superadmin handler
// paths (user status flips), not in this notification-type vocabulary, so
// they are deliberately NOT gated by this matrix; gating them would require
// threading settings into the user-status write path, which is out of scope
// for Slice A and is deferred.
var MandatoryNotificationTypes = map[NotificationType]struct{}{
	NotificationVisitApproved:  {},
	NotificationVisitRejected:  {},
	NotificationVisitCancelled: {},
}

// IsMandatoryNotification reports whether t is a mandatory (locked-Active)
// notification type.
func IsMandatoryNotification(t NotificationType) bool {
	_, ok := MandatoryNotificationTypes[t]
	return ok
}

// NotificationChannelToggle is one cell of the matrix: staff + vendor.
type NotificationChannelToggle struct {
	Staff  bool `json:"staff"`
	Vendor bool `json:"vendor"`
}

// NotificationEventToggle is the per-event row of the matrix.
type NotificationEventToggle struct {
	InApp      NotificationChannelToggle `json:"in_app"`
	Email      NotificationChannelToggle `json:"email"`
	Mandatory  bool                      `json:"mandatory"`
}

// NotificationSettings is the parsed "notifications" app_settings value.
type NotificationSettings struct {
	Toggles map[NotificationType]NotificationEventToggle `json:"-"`
	Raw     map[string]NotificationEventToggle          `json:"-"`
	Version int                                         `json:"-"`
}

// notificationSettingsWire is the on-disk JSON shape: object keyed by event.
type notificationSettingsWire struct {
	// dynamic keys handled via map
}

// UnmarshalJSON accepts an object keyed by notification type.
func (s *NotificationSettings) UnmarshalJSON(data []byte) error {
	var raw map[string]NotificationEventToggle
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	s.Toggles = make(map[NotificationType]NotificationEventToggle, len(raw))
	for k, v := range raw {
		v.Mandatory = IsMandatoryNotification(NotificationType(k))
		s.Toggles[NotificationType(k)] = v
	}
	s.Raw = raw
	return nil
}

// MarshalJSON renders the object keyed by event.
func (s NotificationSettings) MarshalJSON() ([]byte, error) {
	out := make(map[string]NotificationEventToggle, len(s.Toggles))
	for k, v := range s.Toggles {
		v.Mandatory = IsMandatoryNotification(k)
		out[string(k)] = v
	}
	return json.Marshal(out)
}

// DefaultNotificationSettings returns the all-Active matrix: every event,
// channel and audience enabled. This matches today's behaviour (in_app always
// emits; email emits for the emailAllowedTypes set, which EmailAllowed still
// gates separately).
func DefaultNotificationSettings() NotificationSettings {
	s := NotificationSettings{Toggles: make(map[NotificationType]NotificationEventToggle)}
	for _, t := range []NotificationType{
		NotificationVisitRequested, NotificationVisitRescheduled, NotificationVisitCheckIn,
		NotificationVisitCheckOut, NotificationVisitCancelled, NotificationVisitApproved,
		NotificationVisitRejected, NotificationVisitReminder, NotificationVisitAutoCancelled,
	} {
		s.Toggles[t] = NotificationEventToggle{
			InApp:     NotificationChannelToggle{Staff: true, Vendor: true},
			Email:     NotificationChannelToggle{Staff: true, Vendor: true},
			Mandatory: IsMandatoryNotification(t),
		}
	}
	return s
}

// IsInAppEnabled reports whether in_app emission is enabled for t/audience.
// Mandatory types are always enabled (fail-closed to Active).
func (s NotificationSettings) IsInAppEnabled(t NotificationType, audience ...NotificationAudience) bool {
	if IsMandatoryNotification(t) {
		return true
	}
	toggle, ok := s.Toggles[t]
	if !ok {
		return true
	}
	if len(audience) == 0 {
		return toggle.InApp.Staff || toggle.InApp.Vendor
	}
	switch audience[0] {
	case NotificationAudienceStaff:
		return toggle.InApp.Staff
	case NotificationAudienceVendor:
		return toggle.InApp.Vendor
	default:
		return true
	}
}

// IsEmailEnabled reports whether email emission is enabled for t/audience.
// Mandatory types are always enabled (fail-closed to Active).
func (s NotificationSettings) IsEmailEnabled(t NotificationType, audience ...NotificationAudience) bool {
	if IsMandatoryNotification(t) {
		return true
	}
	toggle, ok := s.Toggles[t]
	if !ok {
		return true
	}
	if len(audience) == 0 {
		return toggle.Email.Staff || toggle.Email.Vendor
	}
	switch audience[0] {
	case NotificationAudienceStaff:
		return toggle.Email.Staff
	case NotificationAudienceVendor:
		return toggle.Email.Vendor
	default:
		return true
	}
}

// ParseNotificationSettings parses a stored JSON value into a
// NotificationSettings. On any parse failure it returns the default-Active
// matrix and logs a warning (fail-closed: never boot failure).
func ParseNotificationSettings(raw []byte) NotificationSettings {
	if len(raw) == 0 {
		slog.Warn("notification settings: empty value, using defaults")
		return DefaultNotificationSettings()
	}
	var s NotificationSettings
	if err := json.Unmarshal(raw, &s); err != nil {
		slog.Warn("notification settings: corrupt value, using defaults", "err", err)
		return DefaultNotificationSettings()
	}
	if s.Toggles == nil {
		s.Toggles = DefaultNotificationSettings().Toggles
	}
	// ensure all known types present (default Active for missing)
	def := DefaultNotificationSettings()
	for t, tg := range def.Toggles {
		if _, ok := s.Toggles[t]; !ok {
			s.Toggles[t] = tg
		}
	}
	// stamp mandatory
	for t := range s.Toggles {
		tg := s.Toggles[t]
		tg.Mandatory = IsMandatoryNotification(t)
		s.Toggles[t] = tg
	}
	return s
}

// LoadNotificationSettings is a helper for callers that have a raw value.
func LoadNotificationSettings(raw []byte, version int) NotificationSettings {
	s := ParseNotificationSettings(raw)
	s.Version = version
	return s
}

// SettingsLoader is the port the worker (and repositories) use to fetch the
// current notification settings snapshot. Implementations may hit the DB or
// return a cached value.
type SettingsLoader interface {
	LoadNotificationSettings(ctx context.Context) (NotificationSettings, error)
}

// SettingsRepository is the persistence port for app_settings.
type SettingsRepository interface {
	Get(ctx context.Context, key string) (value []byte, version int, found bool, err error)
	Update(ctx context.Context, key string, value []byte, expectedVersion int, updatedBy *UUID, auditEntry AuditEntry) (int, error)
}
