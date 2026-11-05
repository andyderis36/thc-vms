package domain

import (
	"context"
	"time"
)

// This file owns the PERSISTED per-user notification store (migration 000008).
// It is no longer the derived read-only feed: every notice is a materialised
// row carrying its recipient, its triggering visit and its own read flag, so
// the system can remember what each user has and has not seen.
//
// The domain layer contributes two things:
//
//  1. the closed type/audience vocabulary plus the Notification row the
//     repository hydrates; and
//  2. the PURE templates below, which map a visit lifecycle event onto the
//     (type, title, message, audience) that should be written. Keeping the
//     copy in the domain - not in SQL - is what lets the live write path, the
//     reminder worker and the one-off backfill command share ONE definition.
//
// Emission is derived purely from (toStatus, changed_by IS NULL): the worker
// writes status_history with a NULL actor, so system == (changed_by IS NULL)
// distinguishes the automatic transitions from the human ones without any
// actor-role plumbing. See TransitionNotification.

// NotificationType is the closed notification vocabulary pinned by
// docs/4. openapi.yaml. Nine values: five staff lifecycle notices, three
// vendor decision notices, one vendor reminder.
type NotificationType string

const (
	NotificationVisitRequested     NotificationType = "visit_requested"
	NotificationVisitRescheduled   NotificationType = "visit_rescheduled"
	NotificationVisitCheckIn       NotificationType = "visit_check_in"
	NotificationVisitCheckOut      NotificationType = "visit_check_out"
	NotificationVisitCancelled     NotificationType = "visit_cancelled"
	NotificationVisitApproved      NotificationType = "visit_approved"
	NotificationVisitRejected      NotificationType = "visit_rejected"
	NotificationVisitReminder      NotificationType = "visit_reminder"
	NotificationVisitAutoCancelled NotificationType = "visit_auto_cancelled"
)

// NotificationAudience selects the recipient fan-out performed in SQL: staff
// resolves to the national super_admin plus the branch admin/security, vendor
// resolves to the visit's vendor user.
type NotificationAudience string

const (
	NotificationAudienceStaff  NotificationAudience = "staff"
	NotificationAudienceVendor NotificationAudience = "vendor"
)

// NotificationTemplate is the pure, pre-persistence description of one notice.
// The live emit helper, the reminder worker and the backfill command all build
// one of these and hand it to the repository; nothing here is SQL-aware.
type NotificationTemplate struct {
	Type     NotificationType
	Title    string
	Message  string
	Audience NotificationAudience
}

// TransitionNotification maps a visit status move onto its notification, or nil
// when the move produces no notice. system is true when the writer was the
// automatic worker (status_history.changed_by IS NULL).
//
// Nil cases are deliberate:
//   - completed by the worker (R3 auto-complete) is administrative housekeeping,
//     not an event the branch staff need to be told about;
//   - cancelled by a human emits nothing here because the notice is
//     actor-directed (vendor-cancel routes to staff, admin-cancel routes to
//     the vendor) and built by HumanCancelledNotification in the repository
//     write path, which knows the actor; see UpdateStatus.
func TransitionNotification(to VisitStatus, system bool, visitCode string) *NotificationTemplate {
	switch to {
	case VisitStatusRescheduled:
		return &NotificationTemplate{
			Type:     NotificationVisitRescheduled,
			Title:    "Jadwal kunjungan diperbarui",
			Message:  "Permintaan " + visitCode + " dijadwalkan ulang.",
			Audience: NotificationAudienceStaff,
		}
	case VisitStatusApproved:
		return &NotificationTemplate{
			Type:     NotificationVisitApproved,
			Title:    "Kunjungan disetujui",
			Message:  "Permintaan " + visitCode + " telah disetujui.",
			Audience: NotificationAudienceVendor,
		}
	case VisitStatusRejected:
		return &NotificationTemplate{
			Type:     NotificationVisitRejected,
			Title:    "Kunjungan ditolak",
			Message:  "Permintaan " + visitCode + " ditolak.",
			Audience: NotificationAudienceVendor,
		}
	case VisitStatusVisiting:
		return &NotificationTemplate{
			Type:     NotificationVisitCheckIn,
			Title:    "Check-in tamu",
			Message:  "Tamu " + visitCode + " telah check-in.",
			Audience: NotificationAudienceStaff,
		}
	case VisitStatusCompleted:
		if system {
			return nil
		}
		return &NotificationTemplate{
			Type:     NotificationVisitCheckOut,
			Title:    "Check-out tamu",
			Message:  "Tamu " + visitCode + " telah check-out.",
			Audience: NotificationAudienceStaff,
		}
	case VisitStatusCancelled:
		if system {
			return &NotificationTemplate{
				Type:     NotificationVisitAutoCancelled,
				Title:    "Kunjungan dibatalkan otomatis",
				Message:  "Permintaan " + visitCode + " batal otomatis: tanpa persetujuan 7 hari.",
				Audience: NotificationAudienceVendor,
			}
		}
		return nil
	case VisitStatusNotVisit:
		return &NotificationTemplate{
			Type:     NotificationVisitAutoCancelled,
			Title:    "Kunjungan dibatalkan otomatis",
			Message:  "Permintaan " + visitCode + " batal otomatis: tamu tidak check-in.",
			Audience: NotificationAudienceVendor,
		}
	default:
		return nil
	}
}

// CreatedNotification is the notice raised the moment a visit request is
// created: staff are told a new request is waiting for approval.
func CreatedNotification(visitCode string) *NotificationTemplate {
	return &NotificationTemplate{
		Type:     NotificationVisitRequested,
		Title:    "Permintaan kunjungan baru",
		Message:  "Permintaan " + visitCode + " menunggu persetujuan.",
		Audience: NotificationAudienceStaff,
	}
}

// ReminderNotification is the vendor's heads-up shortly before an approved
// visit's start window opens (worker rule R4).
func ReminderNotification(visitCode string) *NotificationTemplate {
	return &NotificationTemplate{
		Type:     NotificationVisitReminder,
		Title:    "Pengingat kunjungan",
		Message:  "Kunjungan " + visitCode + " akan dimulai sebentar lagi.",
		Audience: NotificationAudienceVendor,
	}
}

// HumanCancelledNotification is the notice for a human-driven cancellation:
// a vendor cancelling its own visit tells the branch staff (byVendor=true),
// while an admin/superadmin cancelling a vendor visit tells the vendor
// (byVendor=false). The automatic worker path never builds this template -
// it keeps emitting visit_auto_cancelled through TransitionNotification.
func HumanCancelledNotification(visitCode string, byVendor bool) *NotificationTemplate {
	if byVendor {
		return &NotificationTemplate{
			Type:     NotificationVisitCancelled,
			Title:    "Kunjungan dibatalkan vendor",
			Message:  "Permintaan " + visitCode + " dibatalkan oleh vendor.",
			Audience: NotificationAudienceStaff,
		}
	}
	return &NotificationTemplate{
		Type:     NotificationVisitCancelled,
		Title:    "Kunjungan dibatalkan",
		Message:  "Permintaan " + visitCode + " dibatalkan oleh admin.",
		Audience: NotificationAudienceVendor,
	}
}

// RescheduledVendorNotification is the vendor's copy of a reschedule: the
// staff feed keeps its own visit_rescheduled row from TransitionNotification
// and the vendor feed gains this second row with the same type. Repeat
// reschedules collapse on the store's unique constraint, so re-emission is
// idempotent.
func RescheduledVendorNotification(visitCode string) *NotificationTemplate {
	return &NotificationTemplate{
		Type:     NotificationVisitRescheduled,
		Title:    "Jadwal kunjungan diperbarui",
		Message:  "Permintaan " + visitCode + " dijadwalkan ulang.",
		Audience: NotificationAudienceVendor,
	}
}

// Notification is one stored notice, already narrowed to a single recipient.
// VisitID/LocationName are read through the visit_request/location joins so the
// wire shape can render them without a second hop.
type Notification struct {
	ID             UUID
	Type           NotificationType
	VisitRequestID UUID
	VisitID        string
	LocationID     UUID
	LocationName   string
	Title          string
	Message        string
	IsRead         bool
	OccurredAt     time.Time
}

// Pagination contract for the notifications feed (docs/4. openapi.yaml: default
// page size 20, maximum 100). These are the ONE source of truth shared by the
// notification usecase (which clamps caller input) and the repository (which
// re-applies the same bounds as its final defensive fallback).
const (
	// DefaultNotificationPageSize is the page size when the caller supplies no
	// limit (or a limit outside the accepted range).
	DefaultNotificationPageSize = 20
	// MaxNotificationPageSize caps a single notifications page.
	MaxNotificationPageSize = 100
)

// NotificationFilter scopes a read to one user. UserID is always set by the
// usecase from the authenticated principal. LocationID is nil for
// super_admin/vendor and set for branch-locked callers (and a super_admin that
// narrows by branch); Page/Limit arrive already clamped.
type NotificationFilter struct {
	UserID     UUID
	LocationID *UUID
	Page       int
	Limit      int
}

// NotificationRepository is the persistence port. Reads are always user-scoped;
// writes fan out to the audience encoded in the template. InsertForVisit is
// idempotent per (user, type, visit) through the store's unique constraint.
// ResolveEmailRecipients is the active-only email mirror of that fan-out for
// the async after-commit mailer: it returns addresses, never an error, for
// inactive or unknown audiences.
type NotificationRepository interface {
	List(ctx context.Context, filter NotificationFilter) (items []Notification, total, unread int64, err error)
	MarkRead(ctx context.Context, id, userID UUID) (bool, error)
	MarkAllRead(ctx context.Context, userID UUID) (int64, error)
	InsertForVisit(ctx context.Context, visit VisitRequest, tpl *NotificationTemplate) error
	ResolveEmailRecipients(ctx context.Context, visit VisitRequest, audience NotificationAudience) ([]string, error)
}
