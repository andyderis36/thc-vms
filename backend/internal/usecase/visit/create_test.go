package visit

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"thc-vms/backend/internal/domain"
)

func TestCreateVisit_ValidRequestCreatesRequestedVisit(t *testing.T) {
	repo := newFakeVisitRepo(t)
	svc := newTestService(repo, nil, testNow())
	actor := testActor(domain.RolePIC, "pic-1", "")

	got, err := svc.CreateVisit(context.Background(), actor, validCreateInput())
	if err != nil {
		t.Fatalf("CreateVisit returned error: %v", err)
	}
	if got.Status != domain.VisitStatusRequested {
		t.Errorf("status = %q, want %q", got.Status, domain.VisitStatusRequested)
	}
	if len(repo.createdVisitors) != 2 {
		t.Errorf("repository received %d visitors, want 2", len(repo.createdVisitors))
	}
	if len(repo.createdPurposes) != 2 {
		t.Errorf("repository received %d purposes, want 2", len(repo.createdPurposes))
	}
	if repo.createdVisit.LocationID != domain.UUID("loc-A") {
		t.Errorf("location = %q, want loc-A", repo.createdVisit.LocationID)
	}
	if !repo.createdVisit.IsNDAAccepted {
		t.Error("IsNDAAccepted = false, want true")
	}
	if repo.createdVisit.PICUserID != actor.ID {
		t.Errorf("PICUserID = %q, want %q", repo.createdVisit.PICUserID, actor.ID)
	}
}

func TestCreateVisit_RejectsMoreThanTenVisitors(t *testing.T) {
	repo := newFakeVisitRepo(t)
	svc := newTestService(repo, nil, testNow())
	actor := testActor(domain.RolePIC, "pic-1", "")

	ten := validCreateInput()
	ten.Visitors = make([]VisitorInput, 10)
	for i := range ten.Visitors {
		ten.Visitors[i] = VisitorInput{
			Name:     fmt.Sprintf("Pengunjung %d", i+1),
			IDNumber: fmt.Sprintf("ID%03d", i+1),
			Phone:    fmt.Sprintf("081%04d", i+1),
		}
	}
	if _, err := svc.CreateVisit(context.Background(), actor, ten); err != nil {
		t.Fatalf("10 visitors must be accepted, got error: %v", err)
	}

	eleven := validCreateInput()
	eleven.Visitors = append(ten.Visitors, VisitorInput{Name: "Lebih", IDNumber: "ID999", Phone: "0899"})
	if _, err := svc.CreateVisit(context.Background(), actor, eleven); err == nil {
		t.Fatal("11 visitors must be rejected, got nil error")
	} else if !errors.Is(err, domain.ErrValidation) {
		t.Errorf("11 visitors error = %v, want validation failure", err)
	}
}

func TestCreateVisit_RejectsReversedDates(t *testing.T) {
	repo := newFakeVisitRepo(t)
	svc := newTestService(repo, nil, testNow())
	actor := testActor(domain.RolePIC, "pic-1", "")

	in := validCreateInput()
	in.StartDate, in.EndDate = in.EndDate, in.StartDate
	if _, err := svc.CreateVisit(context.Background(), actor, in); err == nil {
		t.Fatal("reversed dates must be rejected, got nil error")
	} else if !errors.Is(err, domain.ErrValidation) {
		t.Errorf("reversed dates error = %v, want validation failure", err)
	}

	equal := validCreateInput()
	equal.EndDate = equal.StartDate
	if _, err := svc.CreateVisit(context.Background(), actor, equal); err == nil {
		t.Fatal("equal start/end must be rejected, got nil error")
	} else if !errors.Is(err, domain.ErrValidation) {
		t.Errorf("equal dates error = %v, want validation failure", err)
	}
}

func TestCreateVisit_RejectsMissingNDA(t *testing.T) {
	repo := newFakeVisitRepo(t)
	svc := newTestService(repo, nil, testNow())
	actor := testActor(domain.RolePIC, "pic-1", "")

	in := validCreateInput()
	in.IsNDAAccepted = false
	_, err := svc.CreateVisit(context.Background(), actor, in)
	if err == nil {
		t.Fatal("missing NDA consent must be rejected, got nil error")
	}
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("missing NDA error = %v, want validation failure", err)
	}
	if !strings.Contains(err.Error(), "K3/SOP") {
		t.Errorf("missing NDA message %q must name the K3/SOP consent", err.Error())
	}
}

func TestCreateVisit_RejectsEmptyPurposeList(t *testing.T) {
	repo := newFakeVisitRepo(t)
	svc := newTestService(repo, nil, testNow())
	actor := testActor(domain.RolePIC, "pic-1", "")

	in := validCreateInput()
	in.PurposeIDs = nil
	if _, err := svc.CreateVisit(context.Background(), actor, in); err == nil {
		t.Fatal("empty purpose list must be rejected, got nil error")
	} else if !errors.Is(err, domain.ErrValidation) {
		t.Errorf("empty purpose error = %v, want validation failure", err)
	}
}

func TestCreateVisit_RejectsVisitorMissingIDNumber(t *testing.T) {
	repo := newFakeVisitRepo(t)
	svc := newTestService(repo, nil, testNow())
	actor := testActor(domain.RolePIC, "pic-1", "")

	in := validCreateInput()
	in.Visitors[1].IDNumber = ""
	if _, err := svc.CreateVisit(context.Background(), actor, in); err == nil {
		t.Fatal("visitor without ID number must be rejected, got nil error")
	} else if !errors.Is(err, domain.ErrValidation) {
		t.Errorf("missing ID number error = %v, want validation failure", err)
	}
}

func TestCreateVisit_AdminCannotRequestForAnotherBranch(t *testing.T) {
	repo := newFakeVisitRepo(t)
	svc := newTestService(repo, nil, testNow())
	actor := testActor(domain.RoleAdmin, "admin-1", "loc-B")

	in := validCreateInput()
	in.LocationID = domain.UUID("loc-A")
	if _, err := svc.CreateVisit(context.Background(), actor, in); err == nil {
		t.Fatal("cross-branch admin request must be refused, got nil error")
	} else if !errors.Is(err, domain.ErrForbiddenBranch) {
		t.Errorf("cross-branch error = %v, want forbidden branch", err)
	}
	if repo.createCalls != 0 {
		t.Errorf("createCalls = %d, want 0", repo.createCalls)
	}
}
