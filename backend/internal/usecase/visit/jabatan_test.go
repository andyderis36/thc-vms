package visit

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"thc-vms/backend/internal/domain"
)

func TestCreateVisit_TrimsJabatan(t *testing.T) {
	repo := newFakeVisitRepo(t)
	svc := newTestService(repo, nil, testNow())
	actor := testActor(domain.RoleVendor, "vendor-1", "")

	in := validCreateInput()
	in.Visitors[0].Jabatan = strPtrTest("  Mandor  ")

	got, err := svc.CreateVisit(context.Background(), actor, in)
	if err != nil {
		t.Fatalf("CreateVisit returned error: %v", err)
	}
	if repo.createdVisitors[0].Jabatan == nil || *repo.createdVisitors[0].Jabatan != "Mandor" {
		t.Fatalf("stored jabatan = %v, want trimmed %q", repo.createdVisitors[0].Jabatan, "Mandor")
	}
	if got.Visitors[0].Jabatan == nil || *got.Visitors[0].Jabatan != "Mandor" {
		t.Fatalf("response echo jabatan = %v, want %q", got.Visitors[0].Jabatan, "Mandor")
	}
}

func TestCreateVisit_BlankJabatanBecomesAbsent(t *testing.T) {
	repo := newFakeVisitRepo(t)
	svc := newTestService(repo, nil, testNow())
	actor := testActor(domain.RoleVendor, "vendor-1", "")

	in := validCreateInput()
	in.Visitors[0].Jabatan = strPtrTest("   ")

	got, err := svc.CreateVisit(context.Background(), actor, in)
	if err != nil {
		t.Fatalf("CreateVisit returned error: %v", err)
	}
	if repo.createdVisitors[0].Jabatan != nil {
		t.Fatalf("stored jabatan = %q, want absent (nil)", *repo.createdVisitors[0].Jabatan)
	}
	if got.Visitors[0].Jabatan != nil {
		t.Fatalf("response echo jabatan = %q, want absent (nil)", *got.Visitors[0].Jabatan)
	}
}

func TestCreateVisit_RejectsOverlongJabatan(t *testing.T) {
	repo := newFakeVisitRepo(t)
	svc := newTestService(repo, nil, testNow())
	actor := testActor(domain.RoleVendor, "vendor-1", "")

	in := validCreateInput()
	in.Visitors[0].Jabatan = strPtrTest(strings.Repeat("a", maxJabatanLen))

	if _, err := svc.CreateVisit(context.Background(), actor, in); err != nil {
		t.Fatalf("exactly 120 characters must be accepted, got error: %v", err)
	}

	over := validCreateInput()
	over.Visitors[0].Jabatan = strPtrTest(strings.Repeat("a", maxJabatanLen+1))
	_, err := svc.CreateVisit(context.Background(), actor, over)
	if err == nil {
		t.Fatal("121-character jabatan must be rejected, got nil error")
	}
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("overlong jabatan error = %v, want validation failure", err)
	}
	if !strings.Contains(err.Error(), "Jabatan") {
		t.Errorf("overlong jabatan message %q must name the field", err.Error())
	}
}

func TestListJabatan_DistinctSortedAndBlanksDropped(t *testing.T) {
	repo := newFakeVisitRepo(t)
	repo.jabatanRows = []string{"Teknisi", "Mandor", "Teknisi", "", "   ", "Supervisor"}
	svc := newTestService(repo, nil, testNow())

	got, err := svc.ListJabatan(context.Background())
	if err != nil {
		t.Fatalf("ListJabatan returned error: %v", err)
	}
	want := []string{"Mandor", "Supervisor", "Teknisi"}
	if len(got) != len(want) {
		t.Fatalf("ListJabatan = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("ListJabatan = %v, want %v", got, want)
		}
	}
}

func TestListJabatan_EmptyListIsNonNil(t *testing.T) {
	repo := newFakeVisitRepo(t)
	svc := newTestService(repo, nil, testNow())

	got, err := svc.ListJabatan(context.Background())
	if err != nil {
		t.Fatalf("ListJabatan returned error: %v", err)
	}
	if got == nil {
		t.Fatal("empty suggestion list must be a non-nil slice so the wire renders []")
	}
	if len(got) != 0 {
		t.Fatalf("ListJabatan = %v, want empty", got)
	}
}

func TestListJabatan_CapsAtFifty(t *testing.T) {
	repo := newFakeVisitRepo(t)
	for i := 0; i < 60; i++ {
		repo.jabatanRows = append(repo.jabatanRows, fmt.Sprintf("Jabatan %02d", i))
	}
	svc := newTestService(repo, nil, testNow())

	got, err := svc.ListJabatan(context.Background())
	if err != nil {
		t.Fatalf("ListJabatan returned error: %v", err)
	}
	if len(got) != 50 {
		t.Fatalf("ListJabatan returned %d values, want the 50 cap", len(got))
	}
}

func TestListJabatan_PropagatesRepositoryError(t *testing.T) {
	repo := newFakeVisitRepo(t)
	repo.jabatanErr = domain.ErrDatabase
	svc := newTestService(repo, nil, testNow())

	if _, err := svc.ListJabatan(context.Background()); !errors.Is(err, domain.ErrDatabase) {
		t.Fatalf("ListJabatan error = %v, want ErrDatabase", err)
	}
}

func strPtrTest(s string) *string { return &s }
