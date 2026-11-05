package visit

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"thc-vms/backend/internal/domain"
)

func seedOwnedVisitWithMember(repo *fakeVisitRepo) (domain.VisitRequest, domain.Visitor) {
	visit := seedRequestedVisit(repo)
	member := domain.Visitor{
		ID:             "member-1",
		VisitRequestID: visit.ID,
		Name:           "Andi",
		IDNumber:       "ID12345678",
		Phone:          "081234567890",
	}
	visit.Visitors = []domain.Visitor{member}
	seedVisit(repo, visit)
	return visit, member
}

func strPtr(s string) *string { return &s }

func TestUpdateVisitorContact_OwnerPhoneChangeSetsFlag(t *testing.T) {
	repo := newFakeVisitRepo(t)
	visit, member := seedOwnedVisitWithMember(repo)
	svc := newTestService(repo, nil, testNow())

	updated, err := svc.UpdateVisitorContact(context.Background(), testActor(domain.RoleVendor, "vendor-1", ""), visit.ID, member.ID, strPtr("+62 812-3456-7891"), nil)
	if err != nil {
		t.Fatalf("update = %v, want nil", err)
	}
	if updated.Phone != "081234567891" {
		t.Fatalf("phone = %q, want canonical 081234567891", updated.Phone)
	}
	if !updated.PhoneEdited {
		t.Fatal("phone_edited = false, want true")
	}
	if repo.writes != 1 {
		t.Fatalf("writes = %d, want exactly 1", repo.writes)
	}
}

func TestUpdateVisitorContact_IdenticalValuesAreNoopWithoutWrite(t *testing.T) {
	repo := newFakeVisitRepo(t)
	visit, member := seedOwnedVisitWithMember(repo)
	svc := newTestService(repo, nil, testNow())
	repo.onWrite = func() { t.Fatal("no-op must perform zero repository writes") }

	updated, err := svc.UpdateVisitorContact(context.Background(), testActor(domain.RoleVendor, "vendor-1", ""), visit.ID, member.ID, strPtr("081234567890"), nil)
	if err != nil {
		t.Fatalf("update = %v, want nil", err)
	}
	if updated.PhoneEdited {
		t.Fatalf("phone_edited = true, want false on no-op")
	}
}

func TestUpdateVisitorContact_NonOwnerAnswers404WithoutWrite(t *testing.T) {
	repo := newFakeVisitRepo(t)
	visit, member := seedOwnedVisitWithMember(repo)
	svc := newTestService(repo, nil, testNow())
	repo.onWrite = func() { t.Fatal("refused update must perform zero repository writes") }

	other := testActor(domain.RoleVendor, "vendor-9", "")
	for name, actor := range map[string]Actor{
		"other vendor": other,
		"admin":        testActor(domain.RoleAdmin, "admin-1", "loc-A"),
		"security":     testActor(domain.RoleSecurity, "sec-1", "loc-A"),
		"super_admin":  testActor(domain.RoleSuperAdmin, "root-1", ""),
	} {
		_, err := svc.UpdateVisitorContact(context.Background(), actor, visit.ID, member.ID, strPtr("081234567891"), nil)
		appErr := domain.FromError(err)
		if appErr.Status != http.StatusNotFound {
			t.Fatalf("%s: status = %d, want 404", name, appErr.Status)
		}
		if !strings.Contains(appErr.Message, "Kunjungan") {
			t.Fatalf("%s: message = %q, want the Kunjungan hide-existence wording", name, appErr.Message)
		}
	}
}

func TestUpdateVisitorContact_NonPreApprovalAnswers400WithoutWrite(t *testing.T) {
	for _, status := range []domain.VisitStatus{
		domain.VisitStatusApproved, domain.VisitStatusVisiting,
		domain.VisitStatusRejected, domain.VisitStatusCancelled,
		domain.VisitStatusNotVisit, domain.VisitStatusCompleted,
	} {
		repo := newFakeVisitRepo(t)
		visit, member := seedOwnedVisitWithMember(repo)
		visit.Status = status
		seedVisit(repo, visit)
		svc := newTestService(repo, nil, testNow())
		repo.onWrite = func() { t.Fatal("refused update must perform zero repository writes") }

		_, err := svc.UpdateVisitorContact(context.Background(), testActor(domain.RoleVendor, "vendor-1", ""), visit.ID, member.ID, strPtr("081234567891"), nil)
		if appErr := domain.FromError(err); appErr.Status != http.StatusBadRequest {
			t.Fatalf("%s: status = %d, want 400", status, appErr.Status)
		}
	}
}

func TestUpdateVisitorContact_RescheduledAllowsPhoneChange(t *testing.T) {
	repo := newFakeVisitRepo(t)
	visit, member := seedOwnedVisitWithMember(repo)
	visit.Status = domain.VisitStatusRescheduled
	seedVisit(repo, visit)
	svc := newTestService(repo, nil, testNow())

	updated, err := svc.UpdateVisitorContact(context.Background(), testActor(domain.RoleVendor, "vendor-1", ""), visit.ID, member.ID, strPtr("081234567891"), nil)
	if err != nil {
		t.Fatalf("rescheduled update = %v, want nil", err)
	}
	if updated.Phone != "081234567891" {
		t.Fatalf("phone = %q, want 081234567891", updated.Phone)
	}
	if !updated.PhoneEdited {
		t.Fatal("phone_edited = false, want true")
	}
}

func TestUpdateVisitorContact_InvalidValuesAnswer400(t *testing.T) {
	repo := newFakeVisitRepo(t)
	visit, member := seedOwnedVisitWithMember(repo)
	svc := newTestService(repo, nil, testNow())

	for name, pair := range map[string][2]*string{
		"missing phone":  {nil, nil},
		"blank phone":    {strPtr("   "), nil},
		"short phone":    {strPtr("0811"), nil},
		"bad prefix phone": {strPtr("711234567890"), nil},
		"id_number sent": {strPtr("081234567891"), strPtr("ID12345678")},
	} {
		_, err := svc.UpdateVisitorContact(context.Background(), testActor(domain.RoleVendor, "vendor-1", ""), visit.ID, member.ID, pair[0], pair[1])
		if appErr := domain.FromError(err); appErr.Status != http.StatusBadRequest {
			t.Fatalf("%s: status = %d, want 400", name, appErr.Status)
		}
	}
}

func TestUpdateVisitorContact_UnknownMemberAnswers404(t *testing.T) {
	repo := newFakeVisitRepo(t)
	visit, _ := seedOwnedVisitWithMember(repo)
	svc := newTestService(repo, nil, testNow())

	_, err := svc.UpdateVisitorContact(context.Background(), testActor(domain.RoleVendor, "vendor-1", ""), visit.ID, "member-ghost", strPtr("081234567891"), nil)
	if appErr := domain.FromError(err); appErr.Status != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", appErr.Status)
	}
}
