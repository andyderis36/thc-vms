package visit

import (
	"context"
	"errors"
	"strings"
	"testing"

	"thc-vms/backend/internal/domain"
)

func TestCreateVisit_PersistsMemberEmail(t *testing.T) {
	repo := newFakeVisitRepo(t)
	svc := newTestService(repo, nil, testNow())
	actor := testActor(domain.RoleVendor, "vendor-1", "")

	in := validCreateInput()
	in.Visitors[0].Email = strPtrTest("  teknisi@example.co.id  ")

	got, err := svc.CreateVisit(context.Background(), actor, in)
	if err != nil {
		t.Fatalf("CreateVisit returned error: %v", err)
	}
	if repo.createdVisitors[0].Email == nil || *repo.createdVisitors[0].Email != "teknisi@example.co.id" {
		t.Fatalf("stored email = %v, want trimmed %q", repo.createdVisitors[0].Email, "teknisi@example.co.id")
	}
	if got.Visitors[0].Email == nil || *got.Visitors[0].Email != "teknisi@example.co.id" {
		t.Fatalf("response echo email = %v, want %q", got.Visitors[0].Email, "teknisi@example.co.id")
	}
}

func TestCreateVisit_AbsentEmailStaysAbsent(t *testing.T) {
	repo := newFakeVisitRepo(t)
	svc := newTestService(repo, nil, testNow())
	actor := testActor(domain.RoleVendor, "vendor-1", "")

	got, err := svc.CreateVisit(context.Background(), actor, validCreateInput())
	if err != nil {
		t.Fatalf("CreateVisit returned error: %v", err)
	}
	if repo.createdVisitors[0].Email != nil {
		t.Fatalf("stored email = %q, want absent (nil)", *repo.createdVisitors[0].Email)
	}
	if got.Visitors[0].Email != nil {
		t.Fatalf("response echo email = %q, want absent (nil)", *got.Visitors[0].Email)
	}
}

func TestCreateVisit_BlankEmailBecomesAbsent(t *testing.T) {
	repo := newFakeVisitRepo(t)
	svc := newTestService(repo, nil, testNow())
	actor := testActor(domain.RoleVendor, "vendor-1", "")

	in := validCreateInput()
	in.Visitors[0].Email = strPtrTest("   ")

	got, err := svc.CreateVisit(context.Background(), actor, in)
	if err != nil {
		t.Fatalf("CreateVisit returned error: %v", err)
	}
	if repo.createdVisitors[0].Email != nil {
		t.Fatalf("stored email = %q, want absent (nil)", *repo.createdVisitors[0].Email)
	}
	if got.Visitors[0].Email != nil {
		t.Fatalf("response echo email = %q, want absent (nil)", *got.Visitors[0].Email)
	}
}

func TestCreateVisit_RejectsMalformedMemberEmail(t *testing.T) {
	for _, raw := range []string{"bukan-email", "teknisi@", "@example.co.id", "A <teknisi@example.co.id>"} {
		repo := newFakeVisitRepo(t)
		svc := newTestService(repo, nil, testNow())
		actor := testActor(domain.RoleVendor, "vendor-1", "")

		in := validCreateInput()
		in.Visitors[0].Email = strPtrTest(raw)

		_, err := svc.CreateVisit(context.Background(), actor, in)
		if err == nil {
			t.Fatalf("email %q must be rejected, got nil error", raw)
		}
		if !errors.Is(err, domain.ErrValidation) {
			t.Fatalf("email %q error = %v, want validation failure", raw, err)
		}
	}
}

func TestCreateVisit_RejectsOverlongMemberEmail(t *testing.T) {
	repo := newFakeVisitRepo(t)
	svc := newTestService(repo, nil, testNow())
	actor := testActor(domain.RoleVendor, "vendor-1", "")

	// 254 runes is the longest address the mail box accepts.
	in := validCreateInput()
	local := strings.Repeat("a", 64)
	domain64 := strings.Repeat("b", 63) + "." + strings.Repeat("c", 63) + "." + strings.Repeat("d", 57) + ".co"
	in.Visitors[0].Email = strPtrTest(local + "@" + domain64)
	if _, err := svc.CreateVisit(context.Background(), actor, in); err != nil {
		t.Fatalf("254-rune email must be accepted, got error: %v", err)
	}

	over := validCreateInput()
	over.Visitors[0].Email = strPtrTest(strings.Repeat("a", 244) + "@example.co.id")
	_, err := svc.CreateVisit(context.Background(), actor, over)
	if err == nil {
		t.Fatal("255-rune email must be rejected, got nil error")
	}
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("overlong email error = %v, want validation failure", err)
	}
}
