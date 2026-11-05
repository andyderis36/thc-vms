package auth

import (
	"errors"
	"strings"
	"testing"

	"thc-vms/backend/internal/domain"
)

// TestRegisterVendor_SendsPendingMailToVendor is the S2(a) RED pin: a
// self-registration must mail the vendor inbox itself (pending receipt in
// Indonesian) in addition to the superadmin fan-out. Best-effort: nil mailer
// or send failure still returns the 201 profile.
func TestRegisterVendor_SendsPendingMailToVendor(t *testing.T) {
	managed := &fakeManagedUsers{}
	notices := newFakeNotices()
	directory := mixedStaff()
	mailer := &domain.FakeMailer{}
	svc := NewService(noticeDeps(managed, notices, directory, mailer))

	if _, err := svc.RegisterVendor(auditCtx(), validRegisterInput()); err != nil {
		t.Fatalf("RegisterVendor: %v", err)
	}
	var vendorCall *domain.MailCall
	for i := range mailer.Calls {
		for _, to := range mailer.Calls[i].To {
			if strings.EqualFold(strings.TrimSpace(to), "dimas@vendor.example") {
				vendorCall = &mailer.Calls[i]
			}
		}
	}
	if vendorCall == nil {
		t.Fatalf("no pending mail to vendor inbox, calls = %+v", mailer.Calls)
	}
	if !strings.Contains(vendorCall.Subject, "Pendaftaran") && !strings.Contains(vendorCall.Subject, "pending") && !strings.Contains(vendorCall.Subject, "Diterima") {
		t.Fatalf("pending subject = %q, want pendaftaran-diterima wording", vendorCall.Subject)
	}
	if !strings.Contains(strings.ToLower(vendorCall.TextBody), "diterima") || !strings.Contains(strings.ToLower(vendorCall.TextBody), "verifikasi") {
		t.Fatalf("pending body = %q, want diterima + verifikasi admin copy", vendorCall.TextBody)
	}
}

// TestRegisterVendor_PendingMailFailureStillReturns201 pins the best-effort
// leg: a failing mailer never fails the registration itself.
func TestRegisterVendor_PendingMailFailureStillReturns201(t *testing.T) {
	managed := &fakeManagedUsers{}
	notices := newFakeNotices()
	svc := NewService(noticeDeps(managed, notices, &fakeSuperAdmins{}, &domain.FakeMailer{Err: errors.New("smtp down")}))
	if _, err := svc.RegisterVendor(auditCtx(), validRegisterInput()); err != nil {
		t.Fatalf("registration must succeed despite pending-mail failure: %v", err)
	}
	if len(managed.created) != 1 {
		t.Fatal("row was not stored when the pending mailer was down")
	}
}

// TestRegisterVendor_NilMailerPendingSkipsSilently pins the nil-mailer leg.
func TestRegisterVendor_NilMailerPendingSkipsSilently(t *testing.T) {
	managed := &fakeManagedUsers{}
	notices := newFakeNotices()
	svc := NewService(noticeDeps(managed, notices, mixedStaff(), nil))
	if _, err := svc.RegisterVendor(auditCtx(), validRegisterInput()); err != nil {
		t.Fatalf("registration must succeed without a mailer: %v", err)
	}
	if len(managed.created) != 1 {
		t.Fatal("row was not stored without a mailer")
	}
}
