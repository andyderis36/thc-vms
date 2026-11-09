package auth

import (
	"context"
	"errors"
	"sort"
	"strings"
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
)

// fakeNotices is an in-memory fake of
// domain.VendorRegistrationNoticeRepository: InsertPending is idempotent per
// vendor (repeat calls keep the first row), Resolve flips one row to
// approved/rejected and stamps resolved_at exactly like the table contract.
type fakeNotices struct {
	pendingCalls int
	status       map[domain.UUID]domain.VendorRegistrationStatus
	resolvedAt   map[domain.UUID]time.Time
	insertErr    error
	resolveErr   error
}

func newFakeNotices() *fakeNotices {
	return &fakeNotices{
		status:     map[domain.UUID]domain.VendorRegistrationStatus{},
		resolvedAt: map[domain.UUID]time.Time{},
	}
}

func (f *fakeNotices) InsertPending(_ context.Context, vendorUserID domain.UUID) error {
	f.pendingCalls++
	if f.insertErr != nil {
		return f.insertErr
	}
	if _, ok := f.status[vendorUserID]; !ok {
		f.status[vendorUserID] = domain.VendorRegistrationPending
	}
	return nil
}

func (f *fakeNotices) ListPending(_ context.Context, _, _ int) ([]domain.PendingVendorRegistration, int64, int64, error) {
	return nil, 0, 0, nil
}

func (f *fakeNotices) Resolve(_ context.Context, vendorUserID domain.UUID, status domain.VendorRegistrationStatus) error {
	if f.resolveErr != nil {
		return f.resolveErr
	}
	f.status[vendorUserID] = status
	f.resolvedAt[vendorUserID] = time.Now()
	return nil
}

// staffRow models one staff account behind the directory fake: the role and
// status columns the production predicate reads.
type staffRow struct {
	email  string
	role   domain.RoleName
	status domain.UserStatus
}

// fakeSuperAdmins is a hand-written fake of SuperAdminDirectory: it holds a
// mixed staff table and applies the production predicate verbatim —
// active-only, roles super_admin/dev-superadmin, ordered by email — so the
// tests prove branch admin/security rows can never leak into the fan-out.
type fakeSuperAdmins struct {
	staff []staffRow
	err   error
}

func (f *fakeSuperAdmins) ListSuperAdminEmails(_ context.Context) ([]string, error) {
	if f.err != nil {
		return nil, f.err
	}
	var out []string
	for _, row := range f.staff {
		if row.status != domain.UserStatusActive {
			continue
		}
		if row.role != domain.RoleSuperAdmin && row.role != domain.RoleDevSuperAdmin {
			continue
		}
		out = append(out, row.email)
	}
	sort.Strings(out)
	return out, nil
}

// noticeDeps wires a registration service with the notice queue, the
// superadmin directory and the mailer fakes. The staff table deliberately
// mixes the superadmin set with active branch admin/security rows, an
// inactive superadmin and a blank address so the tests prove the fan-out
// never leaks outside active superadmins and never mails blanks.
func noticeDeps(managed *fakeManagedUsers, notices *fakeNotices, directory *fakeSuperAdmins, mailer domain.Mailer) Deps {
	deps := registerDeps(managed, nil)
	deps.Notices = notices
	deps.SuperAdmins = directory
	deps.Mailer = mailer
	return deps
}

func mixedStaff() *fakeSuperAdmins {
	return &fakeSuperAdmins{staff: []staffRow{
		{email: "superadmin@thc.local", role: domain.RoleSuperAdmin, status: domain.UserStatusActive},
		{email: "dev-superadmin@transhybrid.net.id", role: domain.RoleDevSuperAdmin, status: domain.UserStatusActive},
		{email: "admin-cabang@thc.local", role: domain.RoleAdmin, status: domain.UserStatusActive},
		{email: "security-pos@thc.local", role: domain.RoleSecurity, status: domain.UserStatusActive},
		{email: "ex-superadmin@thc.local", role: domain.RoleSuperAdmin, status: domain.UserStatusInactive},
		{email: "   ", role: domain.RoleSuperAdmin, status: domain.UserStatusActive},
	}}
}

func TestRegisterVendor_FansOutNoticeAndSuperAdminEmail(t *testing.T) {
	managed := &fakeManagedUsers{}
	notices := newFakeNotices()
	directory := mixedStaff()
	mailer := &domain.FakeMailer{}
	svc := NewService(noticeDeps(managed, notices, directory, mailer))

	if _, err := svc.RegisterVendor(auditCtx(), validRegisterInput()); err != nil {
		t.Fatalf("RegisterVendor: %v", err)
	}
	if notices.pendingCalls != 1 {
		t.Fatalf("pending inserts = %d, want exactly 1", notices.pendingCalls)
	}
	if got := notices.status["user-vendor-new"]; got != domain.VendorRegistrationPending {
		t.Fatalf("notice status = %q, want pending", got)
	}
	if len(mailer.Calls) != 2 {
		t.Fatalf("mail calls = %d, want exactly 2 (superadmin fan-out + vendor pending receipt)", len(mailer.Calls))
	}
	call := mailer.Calls[0]
	wantSubject := domain.VendorRegistrationSubject("Dimas Prasetyo")
	if call.Subject != wantSubject {
		t.Fatalf("subject = %q, want %q", call.Subject, wantSubject)
	}
	wantTo := map[string]bool{
		"superadmin@thc.local":                true,
		"dev-superadmin@transhybrid.net.id": true,
	}
	if len(call.To) != len(wantTo) {
		t.Fatalf("recipients = %v, want exactly the superadmin set", call.To)
	}
	for _, addr := range call.To {
		if !wantTo[addr] {
			t.Fatalf("recipients = %v, want exactly the superadmin set (branch staff must be absent)", call.To)
		}
	}
	pending := mailer.Calls[1]
	if len(pending.To) != 1 || pending.To[0] != "dimas@vendor.example" {
		t.Fatalf("pending receipt to = %v, want the vendor inbox only", pending.To)
	}
	// Registration-alert polish: filled fields render their values, the
	// empty company renders the em-dash fallback, and the CTA URL prints
	// exactly once per part (text sentence, HTML button href) — never twice
	// in the HTML where the button already carries it.
	if !strings.Contains(call.TextBody, "Perusahaan: —") {
		t.Fatalf("superadmin text = %q, want the em-dash fallback for the empty company", call.TextBody)
	}
	for _, want := range []string{"Telepon: 081234567890", "NIK: 3201010101900001", "Nama: Dimas Prasetyo"} {
		if !strings.Contains(call.TextBody, want) {
			t.Fatalf("superadmin text = %q, missing %q", call.TextBody, want)
		}
	}
	if n := strings.Count(call.HTMLBody, "/vendor-registrations"); n != 1 {
		t.Fatalf("superadmin HTML prints the CTA URL %d times, want exactly 1 (the button href)", n)
	}
	// The vendor pending receipt carries minimal context, not a bare one-liner.
	for _, want := range []string{"Nama: Dimas Prasetyo", "Email: dimas@vendor.example", "Waktu pendaftaran:"} {
		if !strings.Contains(pending.TextBody, want) {
			t.Fatalf("pending receipt text = %q, missing %q", pending.TextBody, want)
		}
	}
}

func TestRegisterVendor_MailerErrorStillReturns201(t *testing.T) {
	managed := &fakeManagedUsers{}
	notices := newFakeNotices()
	directory := mixedStaff()
	mailer := &domain.FakeMailer{Err: errors.New("smtp down")}
	svc := NewService(noticeDeps(managed, notices, directory, mailer))

	if _, err := svc.RegisterVendor(auditCtx(), validRegisterInput()); err != nil {
		t.Fatalf("registration must succeed despite mailer failure: %v", err)
	}
	if len(managed.created) != 1 {
		t.Fatal("row was not stored when the mailer was down")
	}
	if notices.pendingCalls != 1 {
		t.Fatalf("pending inserts = %d, want exactly 1 even when mail fails", notices.pendingCalls)
	}
	if len(mailer.Calls) != 2 {
		t.Fatalf("mail calls = %d, want both best-effort attempts (superadmin + vendor pending)", len(mailer.Calls))
	}
}

// TestRegisterVendor_NoticeInsertFailureStillReturns201 pins the S1
// best-effort contract after the loud-failure hardening: a dying notice
// queue is logged (slog.Error) and the registration still stands with 201.
func TestRegisterVendor_NoticeInsertFailureStillReturns201(t *testing.T) {
	managed := &fakeManagedUsers{}
	notices := newFakeNotices()
	notices.insertErr = errors.New("queue down")
	directory := mixedStaff()
	mailer := &domain.FakeMailer{}
	svc := NewService(noticeDeps(managed, notices, directory, mailer))

	if _, err := svc.RegisterVendor(auditCtx(), validRegisterInput()); err != nil {
		t.Fatalf("registration must succeed despite notice insert failure: %v", err)
	}
	if len(managed.created) != 1 {
		t.Fatal("row was not stored when the notice queue was down")
	}
	if notices.pendingCalls != 1 {
		t.Fatalf("pending inserts = %d, want exactly 1 attempt even when the queue fails", notices.pendingCalls)
	}
}

func TestRegisterVendor_NilMailerSkipsSilently(t *testing.T) {
	managed := &fakeManagedUsers{}
	notices := newFakeNotices()
	directory := mixedStaff()
	svc := NewService(noticeDeps(managed, notices, directory, nil))

	if _, err := svc.RegisterVendor(auditCtx(), validRegisterInput()); err != nil {
		t.Fatalf("registration must succeed without a mailer: %v", err)
	}
	if len(managed.created) != 1 {
		t.Fatal("row was not stored without a mailer")
	}
	if notices.pendingCalls != 1 {
		t.Fatalf("pending inserts = %d, want exactly 1 without a mailer", notices.pendingCalls)
	}
}

func TestResolveVendorRegistration_ApproveMarksApproved(t *testing.T) {
	managed := &fakeManagedUsers{}
	notices := newFakeNotices()
	svc := NewService(noticeDeps(managed, notices, &fakeSuperAdmins{}, &domain.FakeMailer{}))

	if err := svc.ResolveVendorRegistration(context.Background(), "user-vendor-new", true); err != nil {
		t.Fatalf("ResolveVendorRegistration: %v", err)
	}
	if got := notices.status["user-vendor-new"]; got != domain.VendorRegistrationApproved {
		t.Fatalf("notice status = %q, want approved", got)
	}
	if _, ok := notices.resolvedAt["user-vendor-new"]; !ok {
		t.Fatal("resolved_at was not stamped on approve")
	}
}

func TestResolveVendorRegistration_RejectMarksRejected(t *testing.T) {
	managed := &fakeManagedUsers{}
	notices := newFakeNotices()
	svc := NewService(noticeDeps(managed, notices, &fakeSuperAdmins{}, &domain.FakeMailer{}))

	if err := svc.ResolveVendorRegistration(context.Background(), "user-vendor-new", false); err != nil {
		t.Fatalf("ResolveVendorRegistration: %v", err)
	}
	if got := notices.status["user-vendor-new"]; got != domain.VendorRegistrationRejected {
		t.Fatalf("notice status = %q, want rejected", got)
	}
	if _, ok := notices.resolvedAt["user-vendor-new"]; !ok {
		t.Fatal("resolved_at was not stamped on reject")
	}
}
