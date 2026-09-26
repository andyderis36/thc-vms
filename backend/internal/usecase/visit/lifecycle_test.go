package visit

import (
	"context"
	"errors"
	"testing"

	"thc-vms/backend/internal/domain"
)

func TestApprove_AdminOwnBranchSucceeds(t *testing.T) {
	repo := newFakeVisitRepo(t)
	seedRequestedVisit(repo)
	svc := newTestService(repo, nil, testNow())
	actor := testActor(domain.RoleAdmin, "admin-1", "loc-A")

	if err := svc.Approve(context.Background(), actor, domain.UUID("visit-1"), "disetujui"); err != nil {
		t.Fatalf("Approve returned error: %v", err)
	}
	if len(repo.updateCalls) != 1 {
		t.Fatalf("updateCalls = %d, want 1", len(repo.updateCalls))
	}
	call := repo.updateCalls[0]
	if call.status != domain.VisitStatusApproved {
		t.Errorf("status = %q, want approved", call.status)
	}
	if call.changedBy != actor.ID {
		t.Errorf("changedBy = %q, want %q", call.changedBy, actor.ID)
	}
}

func TestApprove_SuperAdminAnyBranchSucceeds(t *testing.T) {
	repo := newFakeVisitRepo(t)
	seedRequestedVisit(repo)
	svc := newTestService(repo, nil, testNow())
	actor := testActor(domain.RoleSuperAdmin, "super-1", "")

	if err := svc.Approve(context.Background(), actor, domain.UUID("visit-1"), "pusat menyetujui"); err != nil {
		t.Fatalf("Approve returned error: %v", err)
	}
	if len(repo.updateCalls) != 1 || repo.updateCalls[0].status != domain.VisitStatusApproved {
		t.Errorf("updateCalls = %+v, want one approval", repo.updateCalls)
	}
}

func TestApprove_PICAndSecurityAreForbidden(t *testing.T) {
	for _, role := range []domain.RoleName{domain.RolePIC, domain.RoleSecurity} {
		repo := newFakeVisitRepo(t)
		seedRequestedVisit(repo)
		svc := newTestService(repo, nil, testNow())
		actor := testActor(role, "user-1", "loc-A")

		if err := svc.Approve(context.Background(), actor, domain.UUID("visit-1"), "coba"); err == nil {
			t.Errorf("role %q must be forbidden from approving", role)
		} else if !errors.Is(err, domain.ErrForbiddenBranch) {
			t.Errorf("role %q error = %v, want 403 forbidden", role, err)
		}
		if repo.writes != 0 {
			t.Errorf("role %q caused %d repository writes, want 0", role, repo.writes)
		}
	}
}

func TestReject_RequiresReason(t *testing.T) {
	rejected := []string{"", "   ", "abcd"}
	for _, reason := range rejected {
		repo := newFakeVisitRepo(t)
		seedRequestedVisit(repo)
		svc := newTestService(repo, nil, testNow())
		actor := testActor(domain.RoleAdmin, "admin-1", "loc-A")

		if err := svc.Reject(context.Background(), actor, domain.UUID("visit-1"), reason); err == nil {
			t.Errorf("reason %q must be rejected, got nil error", reason)
		} else if !errors.Is(err, domain.ErrValidation) {
			t.Errorf("reason %q error = %v, want validation failure", reason, err)
		}
		if repo.writes != 0 {
			t.Errorf("reason %q caused %d repository writes, want 0", reason, repo.writes)
		}
	}

	repo := newFakeVisitRepo(t)
	seedRequestedVisit(repo)
	svc := newTestService(repo, nil, testNow())
	actor := testActor(domain.RoleAdmin, "admin-1", "loc-A")
	if err := svc.Reject(context.Background(), actor, domain.UUID("visit-1"), "abcde"); err != nil {
		t.Fatalf("5-char reason must be accepted, got error: %v", err)
	}
	if len(repo.updateCalls) != 1 {
		t.Fatalf("updateCalls = %d, want 1", len(repo.updateCalls))
	}
	call := repo.updateCalls[0]
	if call.status != domain.VisitStatusRejected {
		t.Errorf("status = %q, want rejected", call.status)
	}
	if call.notes != "abcde" {
		t.Errorf("notes = %q, want the reason stored as history note", call.notes)
	}
}

func TestCancel_AllowsOwningPICAndBranchAdmin(t *testing.T) {
	repo := newFakeVisitRepo(t)
	seedRequestedVisit(repo)
	svc := newTestService(repo, nil, testNow())

	owner := testActor(domain.RolePIC, "pic-1", "")
	if err := svc.Cancel(context.Background(), owner, domain.UUID("visit-1"), "batal oleh pic"); err != nil {
		t.Fatalf("owning PIC cancel returned error: %v", err)
	}

	visit := seedRequestedVisit(repo)
	visit.ID = domain.UUID("visit-2")
	visit.VisitID = "VST-0000000002"
	seedVisit(repo, visit)
	branchAdmin := testActor(domain.RoleAdmin, "admin-1", "loc-A")
	if err := svc.Cancel(context.Background(), branchAdmin, domain.UUID("visit-2"), "batal oleh admin"); err != nil {
		t.Fatalf("branch admin cancel returned error: %v", err)
	}

	if len(repo.updateCalls) != 2 {
		t.Fatalf("updateCalls = %d, want 2", len(repo.updateCalls))
	}
	for _, call := range repo.updateCalls {
		if call.status != domain.VisitStatusCancelled {
			t.Errorf("status = %q, want cancelled", call.status)
		}
	}
}

func TestCrossBranchAdmin_IsRefusedWithTheExactMandatedMessage(t *testing.T) {
	repo := newFakeVisitRepo(t)
	seedRequestedVisit(repo)
	svc := newTestService(repo, nil, testNow())
	actor := testActor(domain.RoleAdmin, "admin-9", "loc-B")

	err := svc.Approve(context.Background(), actor, domain.UUID("visit-1"), "coba")
	if err == nil {
		t.Fatal("cross-branch admin must be refused, got nil error")
	}
	got := domain.FromError(err).Message
	want := "Tidak berhak mengelola kunjungan cabang lain"
	if got != want {
		t.Errorf("message = %q, want %q byte for byte", got, want)
	}
	if got != domain.ErrForbiddenBranch.Error() {
		t.Errorf("message = %q, want the sentinel text %q", got, domain.ErrForbiddenBranch.Error())
	}
	if repo.writes != 0 {
		t.Errorf("writes = %d, want 0", repo.writes)
	}
}

func TestApprove_OnTerminalVisitIsRefused(t *testing.T) {
	repo := newFakeVisitRepo(t)
	visit := seedRequestedVisit(repo)
	visit.Status = domain.VisitStatusCompleted
	seedVisit(repo, visit)
	svc := newTestService(repo, nil, testNow())
	actor := testActor(domain.RoleAdmin, "admin-1", "loc-A")

	if err := svc.Approve(context.Background(), actor, domain.UUID("visit-1"), "coba"); err == nil {
		t.Fatal("approval of a terminal visit must be refused, got nil error")
	} else if !errors.Is(err, domain.ErrInvalidTransition) {
		t.Errorf("terminal approval error = %v, want invalid transition", err)
	}
	if repo.writes != 0 {
		t.Errorf("writes = %d, want 0", repo.writes)
	}
}

func TestTransitionGuards_AlwaysRunBeforeTheRepository(t *testing.T) {
	repo := newFakeVisitRepo(t)
	seedRequestedVisit(repo)
	repo.onWrite = func() {
		t.Error("repository write called during a refused transition")
	}
	svc := newTestService(repo, nil, testNow())

	terminal := seedRequestedVisit(repo)
	terminal.ID = domain.UUID("visit-terminal")
	terminal.VisitID = "VST-TERMINAL01"
	terminal.Status = domain.VisitStatusRejected
	seedVisit(repo, terminal)

	cases := []struct {
		name string
		call func() error
	}{
		{"pic approves", func() error {
			return svc.Approve(context.Background(), testActor(domain.RolePIC, "pic-1", ""), domain.UUID("visit-1"), "x")
		}},
		{"security approves", func() error {
			return svc.Approve(context.Background(), testActor(domain.RoleSecurity, "sec-1", "loc-A"), domain.UUID("visit-1"), "x")
		}},
		{"cross-branch admin approves", func() error {
			return svc.Approve(context.Background(), testActor(domain.RoleAdmin, "admin-9", "loc-B"), domain.UUID("visit-1"), "x")
		}},
		{"reject without reason", func() error {
			return svc.Reject(context.Background(), testActor(domain.RoleAdmin, "admin-1", "loc-A"), domain.UUID("visit-1"), "")
		}},
		{"approve terminal visit", func() error {
			return svc.Approve(context.Background(), testActor(domain.RoleAdmin, "admin-1", "loc-A"), domain.UUID("visit-terminal"), "x")
		}},
		{"security cancels", func() error {
			return svc.Cancel(context.Background(), testActor(domain.RoleSecurity, "sec-1", "loc-A"), domain.UUID("visit-1"), "x")
		}},
	}
	for _, tc := range cases {
		if err := tc.call(); err == nil {
			t.Errorf("%s: expected refusal, got nil error", tc.name)
		}
	}
	if repo.writes != 0 {
		t.Errorf("writes = %d, want 0 across all refused transitions", repo.writes)
	}
}
