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
	actor := testActor(domain.RoleVendor, "vendor-1", "")

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
	if repo.createdVisit.VendorUserID != actor.ID {
		t.Errorf("VendorUserID = %q, want %q", repo.createdVisit.VendorUserID, actor.ID)
	}
}

func TestCreateVisit_RejectsMoreThanTenVisitors(t *testing.T) {
	repo := newFakeVisitRepo(t)
	svc := newTestService(repo, nil, testNow())
	actor := testActor(domain.RoleVendor, "vendor-1", "")

	ten := validCreateInput()
	ten.Visitors = make([]VisitorInput, 10)
	for i := range ten.Visitors {
		ten.Visitors[i] = VisitorInput{
			Name:     fmt.Sprintf("Pengunjung %d", i+1),
			IDNumber: fmt.Sprintf("ID%03d", i+1),
			Phone:    "0812345678",
		}
	}
	if _, err := svc.CreateVisit(context.Background(), actor, ten); err != nil {
		t.Fatalf("10 visitors must be accepted, got error: %v", err)
	}

	eleven := validCreateInput()
	eleven.Visitors = append(ten.Visitors, VisitorInput{Name: "Lebih", IDNumber: "ID999", Phone: "0812345678"})
	if _, err := svc.CreateVisit(context.Background(), actor, eleven); err == nil {
		t.Fatal("11 visitors must be rejected, got nil error")
	} else if !errors.Is(err, domain.ErrValidation) {
		t.Errorf("11 visitors error = %v, want validation failure", err)
	}
}

func TestCreateVisit_RejectsReversedDates(t *testing.T) {
	repo := newFakeVisitRepo(t)
	svc := newTestService(repo, nil, testNow())
	actor := testActor(domain.RoleVendor, "vendor-1", "")

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
	actor := testActor(domain.RoleVendor, "vendor-1", "")

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
	actor := testActor(domain.RoleVendor, "vendor-1", "")

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
	actor := testActor(domain.RoleVendor, "vendor-1", "")

	in := validCreateInput()
	in.Visitors[1].IDNumber = ""
	if _, err := svc.CreateVisit(context.Background(), actor, in); err == nil {
		t.Fatal("visitor without ID number must be rejected, got nil error")
	} else if !errors.Is(err, domain.ErrValidation) {
		t.Errorf("missing ID number error = %v, want validation failure", err)
	}
}

func activeVendors() []domain.Vendor {
	return []domain.Vendor{
		{ID: domain.UUID("vendor-1"), Name: "PT Lintas Fiber"},
		{ID: domain.UUID("vendor-2"), Name: "PT Daya Power Mandiri"},
	}
}

func TestCreateVisit_MapsPhotoURLAndPerVisitorVendor(t *testing.T) {
	repo := newFakeVisitRepo(t)
	svc := newTestServiceWithVendors(repo, nil, testNow(), activeVendors())
	actor := testActor(domain.RoleVendor, "vendor-1", "")

	vendorID := domain.UUID("vendor-1")
	selfie := "http://localhost:9000/thc-vms-bucket/id_card/visit-1/selfie.jpg"
	in := validCreateInput()
	in.Visitors[0].PhotoURL = &selfie
	in.Visitors[0].VendorID = &vendorID

	got, err := svc.CreateVisit(context.Background(), actor, in)
	if err != nil {
		t.Fatalf("CreateVisit returned error: %v", err)
	}
	if repo.createdVisit.VendorID != "" {
		t.Errorf("top-level VendorID = %q, want empty (company travels per visitor)", repo.createdVisit.VendorID)
	}
	if len(repo.createdVisitors) != 2 {
		t.Fatalf("repository received %d visitors, want 2", len(repo.createdVisitors))
	}
	if repo.createdVisitors[0].VendorID != vendorID {
		t.Errorf("Visitors[0].VendorID = %q, want vendor-1", repo.createdVisitors[0].VendorID)
	}
	if repo.createdVisitors[1].VendorID != "" {
		t.Errorf("Visitors[1].VendorID = %q, want empty for the vendor-less technician", repo.createdVisitors[1].VendorID)
	}
	if repo.createdVisitors[0].PhotoURL == nil || *repo.createdVisitors[0].PhotoURL != selfie {
		t.Errorf("PhotoURL = %v, want %q", repo.createdVisitors[0].PhotoURL, selfie)
	}
	if repo.createdVisitors[1].PhotoURL != nil {
		t.Errorf("PhotoURL = %v, want nil for the visitor without a selfie", repo.createdVisitors[1].PhotoURL)
	}
	if len(got.Visitors) != 2 {
		t.Fatalf("created roster has %d visitors, want 2", len(got.Visitors))
	}
	if got.Visitors[0].VendorName != "PT Lintas Fiber" {
		t.Errorf("Visitors[0].VendorName = %q, want PT Lintas Fiber", got.Visitors[0].VendorName)
	}
	if got.Visitors[1].VendorName != "" {
		t.Errorf("Visitors[1].VendorName = %q, want empty without a vendor", got.Visitors[1].VendorName)
	}
	if got.VendorName != "" {
		t.Errorf("top-level VendorName = %q, want empty (company travels per visitor)", got.VendorName)
	}
}

func TestCreateVisit_RejectsUnknownPerVisitorVendor(t *testing.T) {
	repo := newFakeVisitRepo(t)
	svc := newTestServiceWithVendors(repo, nil, testNow(), activeVendors())
	actor := testActor(domain.RoleVendor, "vendor-1", "")

	unknown := domain.UUID("vendor-asing")
	in := validCreateInput()
	in.Visitors[1].VendorID = &unknown
	if _, err := svc.CreateVisit(context.Background(), actor, in); err == nil {
		t.Fatal("unknown vendor must be rejected, got nil error")
	} else if !errors.Is(err, domain.ErrValidation) {
		t.Errorf("unknown vendor error = %v, want validation failure", err)
	}
	if repo.createCalls != 0 {
		t.Errorf("createCalls = %d, want 0", repo.createCalls)
	}
}

func TestCreateVisit_AcceptsVisitWithoutVendor(t *testing.T) {
	repo := newFakeVisitRepo(t)
	svc := newTestServiceWithVendors(repo, nil, testNow(), activeVendors())
	actor := testActor(domain.RoleVendor, "vendor-1", "")

	got, err := svc.CreateVisit(context.Background(), actor, validCreateInput())
	if err != nil {
		t.Fatalf("vendor-less visit must be accepted, got error: %v", err)
	}
	if repo.createdVisit.VendorID != "" {
		t.Errorf("VendorID = %q, want empty for internal staff", repo.createdVisit.VendorID)
	}
	for i, visitor := range repo.createdVisitors {
		if visitor.VendorID != "" {
			t.Errorf("Visitors[%d].VendorID = %q, want empty without a vendor", i, visitor.VendorID)
		}
	}
	for i, visitor := range got.Visitors {
		if visitor.VendorName != "" {
			t.Errorf("Visitors[%d].VendorName = %q, want empty without a vendor", i, visitor.VendorName)
		}
	}
	if got.VendorName != "" {
		t.Errorf("VendorName = %q, want empty without a vendor", got.VendorName)
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
