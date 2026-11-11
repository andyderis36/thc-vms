package domain_test

import (
	"strings"
	"testing"

	"thc-vms/backend/internal/domain"
)

// TestHumanCancelledNotification_VendorCancelRoutesToStaff proves a vendor
// cancelling its own visit notifies the branch staff (and nobody else): the
// vendor feed must gain NO new cancel row, so the audience is staff-only.
func TestHumanCancelledNotification_VendorCancelRoutesToStaff(t *testing.T) {
	// Given: the owning vendor cancels its own visit.
	// When:  the human-cancel template is built with byVendor=true.
	// Then:   the notice is a staff-audience visit_cancelled row.
	tpl := domain.HumanCancelledNotification("VST-0000000001", true, "")
	if tpl == nil {
		t.Fatal("HumanCancelledNotification(byVendor=true) = nil, want a staff notice")
	}
	if tpl.Type != domain.NotificationVisitCancelled {
		t.Fatalf("type = %q, want %q", tpl.Type, domain.NotificationVisitCancelled)
	}
	if tpl.Audience != domain.NotificationAudienceStaff {
		t.Fatalf("audience = %q, want %q", tpl.Audience, domain.NotificationAudienceStaff)
	}
	if !strings.Contains(tpl.Message, "dibatalkan oleh vendor.") {
		t.Fatalf("message = %q, want the legacy role-word fallback", tpl.Message)
	}
}

// TestHumanCancelledNotification_AdminCancelRoutesToVendor proves an
// admin/superadmin cancelling a vendor visit notifies the vendor: the
// branch-scoped staff fan-out must NOT fire, so the audience is vendor-only.
func TestHumanCancelledNotification_AdminCancelRoutesToVendor(t *testing.T) {
	// Given: an admin cancels a vendor visit.
	// When:  the human-cancel template is built with byVendor=false.
	// Then:   the notice is a vendor-audience visit_cancelled row.
	tpl := domain.HumanCancelledNotification("VST-0000000001", false, "")
	if tpl == nil {
		t.Fatal("HumanCancelledNotification(byVendor=false) = nil, want a vendor notice")
	}
	if tpl.Type != domain.NotificationVisitCancelled {
		t.Fatalf("type = %q, want %q", tpl.Type, domain.NotificationVisitCancelled)
	}
	if tpl.Audience != domain.NotificationAudienceVendor {
		t.Fatalf("audience = %q, want %q", tpl.Audience, domain.NotificationAudienceVendor)
	}
	if !strings.Contains(tpl.Message, "dibatalkan oleh admin.") {
		t.Fatalf("message = %q, want the legacy role-word fallback", tpl.Message)
	}
}

// TestHumanCancelledNotification_NamesThePerson proves the cancel message
// carries the resolved actor fragment ("Nama (Label Peran)") instead of the
// bare role word.
func TestHumanCancelledNotification_NamesThePerson(t *testing.T) {
	tpl := domain.HumanCancelledNotification("VST-0000000001", false, "Budi Santoso (Admin Cabang)")
	if !strings.Contains(tpl.Message, "dibatalkan oleh Budi Santoso (Admin Cabang).") {
		t.Fatalf("message = %q, want the person named with the role label", tpl.Message)
	}
}

// TestRescheduledVendorNotification_IsVendorRescheduledNotice proves any
// reschedule also notifies the vendor with the honest rescheduled type: the
// staff feed keeps its own visit_rescheduled row and the vendor feed gains a
// second visit_rescheduled row (one row per audience, de-duplicated by the
// store's unique constraint on repeat reschedules).
func TestRescheduledVendorNotification_IsVendorRescheduledNotice(t *testing.T) {
	// Given/When: a visit is rescheduled.
	tpl := domain.RescheduledVendorNotification("VST-0000000001", "")
	// Then: it is a vendor-facing visit_rescheduled notice, non-nil.
	if tpl == nil {
		t.Fatal("RescheduledVendorNotification() = nil, want a vendor notice")
	}
	if tpl.Type != domain.NotificationVisitRescheduled {
		t.Fatalf("type = %q, want %q", tpl.Type, domain.NotificationVisitRescheduled)
	}
	if tpl.Audience != domain.NotificationAudienceVendor {
		t.Fatalf("audience = %q, want %q", tpl.Audience, domain.NotificationAudienceVendor)
	}
}

// TestRescheduledVendorNotification_EmptyReasonKeepsLegacyMessage proves a
// reason-less reschedule renders the legacy bell copy byte-identical: old
// rows and reason-free emits never gain a dangling "Alasan:" suffix.
func TestRescheduledVendorNotification_EmptyReasonKeepsLegacyMessage(t *testing.T) {
	const legacy = "Permintaan VST-0000000001 dijadwalkan ulang."
	for _, reason := range []string{"", "   "} {
		if got := domain.RescheduledVendorNotification("VST-0000000001", reason); got.Message != legacy {
			t.Fatalf("message with reason %q = %q, want legacy %q", reason, got.Message, legacy)
		}
		if got := domain.TransitionNotification(domain.VisitStatusRescheduled, false, "VST-0000000001", reason); got.Message != legacy {
			t.Fatalf("staff message with reason %q = %q, want legacy %q", reason, got.Message, legacy)
		}
	}
}

// TestRescheduledNotifications_CarryReason proves a reschedule with a reason
// appends it to BOTH bell copies: the vendor row and the staff row from the
// rescheduled TransitionNotification branch.
func TestRescheduledNotifications_CarryReason(t *testing.T) {
	const reason = "genset telat, geser sehari"
	vendor := domain.RescheduledVendorNotification("VST-0000000001", reason)
	staff := domain.TransitionNotification(domain.VisitStatusRescheduled, false, "VST-0000000001", reason)
	for name, tpl := range map[string]*domain.NotificationTemplate{"vendor": vendor, "staff": staff} {
		if !strings.Contains(tpl.Message, reason) {
			t.Fatalf("%s message = %q, want it to contain the reason %q", name, tpl.Message, reason)
		}
		if !strings.HasPrefix(tpl.Message, "Permintaan VST-0000000001 dijadwalkan ulang.") {
			t.Fatalf("%s message = %q, want the legacy sentence kept as prefix", name, tpl.Message)
		}
	}
}

// TestRescheduledNotifications_TruncateLongReason proves a very long reason
// is cut to ~140 runes in the bell instead of bloating the feed row.
func TestRescheduledNotifications_TruncateLongReason(t *testing.T) {
	long := strings.Repeat("genset telat, ", 20)
	if len([]rune(long)) <= 140 {
		t.Fatalf("test setup: long reason is %d runes, want over 140", len([]rune(long)))
	}
	for name, tpl := range map[string]*domain.NotificationTemplate{
		"vendor": domain.RescheduledVendorNotification("VST-0000000001", long),
		"staff":  domain.TransitionNotification(domain.VisitStatusRescheduled, false, "VST-0000000001", long),
	} {
		if strings.Contains(tpl.Message, long) {
			t.Fatalf("%s message carries the full %d-rune reason untruncated", name, len([]rune(long)))
		}
		want := string([]rune(strings.TrimSpace(long))[:140])
		if !strings.Contains(tpl.Message, want) {
			t.Fatalf("%s message = %q, want it to contain the first 140 runes", name, tpl.Message)
		}
	}
}
