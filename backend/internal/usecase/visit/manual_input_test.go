package visit

import (
	"context"
	"errors"
	"strings"
	"testing"

	"thc-vms/backend/internal/domain"
)

// TestCreateVisit_ManualVendorNameStoredAndEchoed pins the per-technician
// manual company: with no vendor_id the typed text is stored as the override
// and echoed back as the resolved vendor_name.
func TestCreateVisit_ManualVendorNameStoredAndEchoed(t *testing.T) {
	repo := newFakeVisitRepo(t)
	svc := newTestServiceWithVendors(repo, nil, testNow(), activeVendors())
	actor := testActor(domain.RoleVendor, "pic-1", "")

	manual := "PT Subkon Mandiri"
	in := validCreateInput()
	in.Visitors[0].VendorName = &manual

	got, err := svc.CreateVisit(context.Background(), actor, in)
	if err != nil {
		t.Fatalf("CreateVisit returned error: %v", err)
	}
	if len(repo.createdVisitors) != 2 {
		t.Fatalf("repository received %d visitors, want 2", len(repo.createdVisitors))
	}
	stored := repo.createdVisitors[0]
	if stored.VendorID != "" {
		t.Errorf("Visitors[0].VendorID = %q, want empty without a catalogue link", stored.VendorID)
	}
	if stored.VendorNameOverride == nil || *stored.VendorNameOverride != manual {
		t.Errorf("Visitors[0].VendorNameOverride = %v, want %q", stored.VendorNameOverride, manual)
	}
	if len(got.Visitors) != 2 {
		t.Fatalf("created roster has %d visitors, want 2", len(got.Visitors))
	}
	if got.Visitors[0].VendorName != manual {
		t.Errorf("Visitors[0].VendorName = %q, want the manual text %q", got.Visitors[0].VendorName, manual)
	}
	if got.Visitors[1].VendorName != "" {
		t.Errorf("Visitors[1].VendorName = %q, want empty without a company", got.Visitors[1].VendorName)
	}
}

// TestCreateVisit_VendorIDWinsOverManualName pins the catalogue-wins rule:
// when both travel together the catalogue name resolves and the manual text
// is discarded, never stored alongside the link.
func TestCreateVisit_VendorIDWinsOverManualName(t *testing.T) {
	repo := newFakeVisitRepo(t)
	svc := newTestServiceWithVendors(repo, nil, testNow(), activeVendors())
	actor := testActor(domain.RoleVendor, "pic-1", "")

	vendorID := domain.UUID("vendor-1")
	manual := "PT Tidak Terdaftar"
	in := validCreateInput()
	in.Visitors[0].VendorID = &vendorID
	in.Visitors[0].VendorName = &manual

	got, err := svc.CreateVisit(context.Background(), actor, in)
	if err != nil {
		t.Fatalf("CreateVisit returned error: %v", err)
	}
	stored := repo.createdVisitors[0]
	if stored.VendorID != vendorID {
		t.Errorf("Visitors[0].VendorID = %q, want vendor-1", stored.VendorID)
	}
	if stored.VendorNameOverride != nil {
		t.Errorf("Visitors[0].VendorNameOverride = %q, want nil when the catalogue wins", *stored.VendorNameOverride)
	}
	if got.Visitors[0].VendorName != "PT Lintas Fiber" {
		t.Errorf("Visitors[0].VendorName = %q, want the catalogue name, not the manual text", got.Visitors[0].VendorName)
	}
}

// TestCreateVisit_RejectsOverlongManualVendorName pins the 120-rune cap on
// the trimmed manual company.
func TestCreateVisit_RejectsOverlongManualVendorName(t *testing.T) {
	repo := newFakeVisitRepo(t)
	svc := newTestServiceWithVendors(repo, nil, testNow(), activeVendors())
	actor := testActor(domain.RoleVendor, "pic-1", "")

	tooLong := strings.Repeat("A", 121)
	in := validCreateInput()
	in.Visitors[1].VendorName = &tooLong
	if _, err := svc.CreateVisit(context.Background(), actor, in); err == nil {
		t.Fatal("121-rune manual vendor must be rejected, got nil error")
	} else if !errors.Is(err, domain.ErrValidation) {
		t.Errorf("overlong vendor error = %v, want validation failure", err)
	}
	if repo.createCalls != 0 {
		t.Errorf("createCalls = %d, want 0", repo.createCalls)
	}

	exact := strings.Repeat("B", 120)
	ok := validCreateInput()
	ok.Visitors[1].VendorName = &exact
	if _, err := svc.CreateVisit(context.Background(), actor, ok); err != nil {
		t.Fatalf("120-rune manual vendor must be accepted, got error: %v", err)
	}
}

// TestCreateVisit_PurposeNoteOnlyAccepted pins the free-typed purpose: a
// visit with no catalogue purpose but a typed note files successfully and
// the note travels to the repository.
func TestCreateVisit_PurposeNoteOnlyAccepted(t *testing.T) {
	repo := newFakeVisitRepo(t)
	svc := newTestService(repo, nil, testNow())
	actor := testActor(domain.RoleVendor, "pic-1", "")

	in := validCreateInput()
	in.PurposeIDs = nil
	in.PurposeNote = "Perbaikan darurat di luar katalog"

	got, err := svc.CreateVisit(context.Background(), actor, in)
	if err != nil {
		t.Fatalf("purpose_note-only visit must be accepted, got error: %v", err)
	}
	if len(repo.createdPurposes) != 0 {
		t.Errorf("repository received %d purposes, want 0 without catalogue links", len(repo.createdPurposes))
	}
	if repo.createdVisit.PurposeNote == nil || *repo.createdVisit.PurposeNote != "Perbaikan darurat di luar katalog" {
		t.Errorf("stored PurposeNote = %v, want the typed note", repo.createdVisit.PurposeNote)
	}
	if got.PurposeNote == nil || *got.PurposeNote != "Perbaikan darurat di luar katalog" {
		t.Errorf("echoed PurposeNote = %v, want the typed note", got.PurposeNote)
	}
}

// TestCreateVisit_RejectsMissingPurposeAndNote pins the minimal-purpose
// rule: neither a catalogue purpose nor a typed note is a 400-class refusal.
func TestCreateVisit_RejectsMissingPurposeAndNote(t *testing.T) {
	repo := newFakeVisitRepo(t)
	svc := newTestService(repo, nil, testNow())
	actor := testActor(domain.RoleVendor, "pic-1", "")

	in := validCreateInput()
	in.PurposeIDs = nil
	in.PurposeNote = "   "
	if _, err := svc.CreateVisit(context.Background(), actor, in); err == nil {
		t.Fatal("visit without purpose and note must be rejected, got nil error")
	} else if !errors.Is(err, domain.ErrValidation) {
		t.Errorf("missing purpose error = %v, want validation failure", err)
	}
	if repo.createCalls != 0 {
		t.Errorf("createCalls = %d, want 0", repo.createCalls)
	}
}

// TestCreateVisit_RejectsOverlongPurposeNote pins the 200-rune cap on the
// trimmed free-typed purpose.
func TestCreateVisit_RejectsOverlongPurposeNote(t *testing.T) {
	repo := newFakeVisitRepo(t)
	svc := newTestService(repo, nil, testNow())
	actor := testActor(domain.RoleVendor, "pic-1", "")

	in := validCreateInput()
	in.PurposeIDs = nil
	in.PurposeNote = strings.Repeat("C", 201)
	if _, err := svc.CreateVisit(context.Background(), actor, in); err == nil {
		t.Fatal("201-rune purpose note must be rejected, got nil error")
	} else if !errors.Is(err, domain.ErrValidation) {
		t.Errorf("overlong note error = %v, want validation failure", err)
	}
	if repo.createCalls != 0 {
		t.Errorf("createCalls = %d, want 0", repo.createCalls)
	}
}
