package visit

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
)

// scopedVendorRow and scopedMemberRow let the fake honor the filter the usecase
// supplies, so a test can prove an out-of-scope row never reaches the caller.
type scopedVendorRow struct {
	location   domain.UUID
	suggestion domain.VendorSuggestion
}

type scopedMemberRow struct {
	location   domain.UUID
	suggestion domain.MemberSuggestion
}

type fakeSuggestionRepo struct {
	vendorRows []scopedVendorRow
	vendorErr  error
	vendorCall int
	lastVendor domain.VendorSuggestionFilter

	memberRows []scopedMemberRow
	ownedRows  []domain.MemberSuggestion
	memberErr  error
	memberCall int
	lastMember domain.MemberSuggestionFilter

	visitor     domain.Visitor
	visitorErr  error
	visitorCall int
}

func (f *fakeSuggestionRepo) ListVendorSuggestions(_ context.Context, filter domain.VendorSuggestionFilter) ([]domain.VendorSuggestion, error) {
	f.vendorCall++
	f.lastVendor = filter
	if f.vendorErr != nil {
		return nil, f.vendorErr
	}
	out := make([]domain.VendorSuggestion, 0, len(f.vendorRows))
	for _, row := range f.vendorRows {
		if filter.IsGlobal || containsUUID(filter.LocationIDs, row.location) {
			out = append(out, row.suggestion)
		}
	}
	return out, nil
}

func (f *fakeSuggestionRepo) ListMemberSuggestions(_ context.Context, filter domain.MemberSuggestionFilter) ([]domain.MemberSuggestion, error) {
	f.memberCall++
	f.lastMember = filter
	if f.memberErr != nil {
		return nil, f.memberErr
	}
	if filter.VendorUserID != nil {
		return f.ownedRows, nil
	}
	out := make([]domain.MemberSuggestion, 0, len(f.memberRows))
	for _, row := range f.memberRows {
		if filter.IsGlobal || containsUUID(filter.LocationIDs, row.location) {
			out = append(out, row.suggestion)
		}
	}
	return out, nil
}

func (f *fakeSuggestionRepo) FindVisitorByID(_ context.Context, _ domain.UUID) (domain.Visitor, error) {
	f.visitorCall++
	if f.visitorErr != nil {
		return domain.Visitor{}, f.visitorErr
	}
	return f.visitor, nil
}

func containsUUID(ids []domain.UUID, target domain.UUID) bool {
	for _, id := range ids {
		if id == target {
			return true
		}
	}
	return false
}

func newSuggestionService(repo *fakeVisitRepo, suggestions *fakeSuggestionRepo) *Service {
	return newTestService(repo, nil, testNow()).WithSuggestions(suggestions)
}

func TestMergeVendorSuggestionsPriorityAndCasing(t *testing.T) {
	got := mergeVendorSuggestions([]domain.VendorSuggestion{
		{Name: " pt gamma ", Source: domain.VendorSuggestionSourceHistory},
		{Name: "Pt Gamma", Source: domain.VendorSuggestionSourceAccount},
		{Name: "PT GAMMA", Source: domain.VendorSuggestionSourceMaster},
		{Name: "   ", Source: domain.VendorSuggestionSourceMaster},
		{Name: "PT Delta", Source: domain.VendorSuggestionSourceHistory},
	})
	want := []domain.VendorSuggestion{
		{Name: "PT Delta", Source: domain.VendorSuggestionSourceHistory},
		{Name: "PT GAMMA", Source: domain.VendorSuggestionSourceMaster},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("merge = %+v, want %+v", got, want)
	}
}

func TestMergeVendorSuggestionsSameSourceKeepsStableCasing(t *testing.T) {
	got := mergeVendorSuggestions([]domain.VendorSuggestion{
		{Name: "beta fiber", Source: domain.VendorSuggestionSourceHistory},
		{Name: "Beta Fiber", Source: domain.VendorSuggestionSourceHistory},
	})
	if len(got) != 1 {
		t.Fatalf("got %d rows, want 1: %+v", len(got), got)
	}
	if got[0].Name != "Beta Fiber" {
		t.Fatalf("casing = %q, want the deterministic alphabetical casing", got[0].Name)
	}
}

func TestListVendorSuggestionsRoleMatrix(t *testing.T) {
	for _, role := range []domain.RoleName{domain.RoleSecurity, domain.RoleVendor} {
		repo := &fakeSuggestionRepo{}
		svc := newSuggestionService(newFakeVisitRepo(t), repo)
		_, err := svc.ListVendorSuggestions(context.Background(), testActor(role, "actor-1", "loc-A"), "")
		if !errors.Is(err, domain.ErrForbiddenBranch) {
			t.Fatalf("%s: err = %v, want forbidden", role, err)
		}
		if repo.vendorCall != 0 {
			t.Fatalf("%s: repository was called on a refused role", role)
		}
	}
}

func TestListVendorSuggestionsAdminSeesOnlyScopedNames(t *testing.T) {
	repo := &fakeSuggestionRepo{vendorRows: []scopedVendorRow{
		{location: "loc-A", suggestion: domain.VendorSuggestion{Name: "PT Alpha", Source: domain.VendorSuggestionSourceMaster}},
		{location: "loc-B", suggestion: domain.VendorSuggestion{Name: "PT Beta", Source: domain.VendorSuggestionSourceMaster}},
	}}
	svc := newSuggestionService(newFakeVisitRepo(t), repo)
	actor := testActor(domain.RoleAdmin, "admin-1", "loc-A")
	actor.Branches = []domain.UUID{"loc-A"}

	got, err := svc.ListVendorSuggestions(context.Background(), actor, "  pt  ")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 1 || got[0].Name != "PT Alpha" {
		t.Fatalf("got %+v, want only the in-scope PT Alpha", got)
	}
	if repo.lastVendor.IsGlobal {
		t.Fatal("an admin must never be treated as global")
	}
	if !reflect.DeepEqual(repo.lastVendor.LocationIDs, []domain.UUID{"loc-A"}) {
		t.Fatalf("filter union = %+v, want [loc-A]", repo.lastVendor.LocationIDs)
	}
	if repo.lastVendor.Query != "pt" {
		t.Fatalf("query = %q, want trimmed %q", repo.lastVendor.Query, "pt")
	}
}

func TestListVendorSuggestionsSuperAdminIsGlobal(t *testing.T) {
	repo := &fakeSuggestionRepo{}
	svc := newSuggestionService(newFakeVisitRepo(t), repo)

	if _, err := svc.ListVendorSuggestions(context.Background(), testActor(domain.RoleSuperAdmin, "super-1", ""), ""); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !repo.lastVendor.IsGlobal {
		t.Fatal("super_admin must resolve global")
	}
	if len(repo.lastVendor.LocationIDs) != 0 {
		t.Fatalf("global filter carried a union: %+v", repo.lastVendor.LocationIDs)
	}
}

func TestSuggestionQueryLengthGuard(t *testing.T) {
	repo := &fakeSuggestionRepo{}
	svc := newSuggestionService(newFakeVisitRepo(t), repo)
	actor := testActor(domain.RoleSuperAdmin, "super-1", "")

	if _, err := svc.ListVendorSuggestions(context.Background(), actor, strings.Repeat("a", 81)); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("81-char q: err = %v, want validation", err)
	}
	if repo.vendorCall != 0 {
		t.Fatal("an oversized q must be refused before the repository call")
	}
	if _, err := svc.ListMemberSuggestions(context.Background(), actor, MemberSuggestionsInput{Query: strings.Repeat("a", 81)}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("81-char member q: err = %v, want validation", err)
	}
	if repo.memberCall != 0 {
		t.Fatal("an oversized member q must be refused before the repository call")
	}
	if _, err := svc.ListVendorSuggestions(context.Background(), actor, strings.Repeat("a", 80)); err != nil {
		t.Fatalf("80-char q must pass: %v", err)
	}
}

func TestListMemberSuggestionsRoleMatrixAndScope(t *testing.T) {
	repo := &fakeSuggestionRepo{}
	svc := newSuggestionService(newFakeVisitRepo(t), repo)

	if _, err := svc.ListMemberSuggestions(context.Background(), testActor(domain.RoleSecurity, "sec-1", "loc-A"), MemberSuggestionsInput{}); !errors.Is(err, domain.ErrForbiddenBranch) {
		t.Fatalf("security: err = %v, want forbidden", err)
	}
	if repo.memberCall != 0 {
		t.Fatal("security must never reach the member repository")
	}

	vendor := testActor(domain.RoleVendor, "vendor-1", "")
	if _, err := svc.ListMemberSuggestions(context.Background(), vendor, MemberSuggestionsInput{Vendor: "Another Co"}); err != nil {
		t.Fatalf("vendor: unexpected error: %v", err)
	}
	if repo.lastMember.VendorUserID == nil || *repo.lastMember.VendorUserID != "vendor-1" {
		t.Fatalf("vendor filter = %+v, want forced actor id", repo.lastMember)
	}
	if repo.lastMember.VendorName != "" {
		t.Fatalf("vendor role forwarded a vendor name narrow: %q", repo.lastMember.VendorName)
	}

	admin := testActor(domain.RoleAdmin, "admin-1", "loc-A")
	admin.Branches = []domain.UUID{"loc-A", "loc-C"}
	if _, err := svc.ListMemberSuggestions(context.Background(), admin, MemberSuggestionsInput{Vendor: "  Acme  "}); err != nil {
		t.Fatalf("admin: unexpected error: %v", err)
	}
	if repo.lastMember.IsGlobal || repo.lastMember.VendorUserID != nil {
		t.Fatalf("admin filter must be branch-scoped: %+v", repo.lastMember)
	}
	if !reflect.DeepEqual(repo.lastMember.LocationIDs, []domain.UUID{"loc-A", "loc-C"}) {
		t.Fatalf("admin union = %+v", repo.lastMember.LocationIDs)
	}
	if repo.lastMember.VendorName != "Acme" {
		t.Fatalf("admin vendor narrow = %q, want trimmed Acme", repo.lastMember.VendorName)
	}

	super := testActor(domain.RoleSuperAdmin, "super-1", "")
	if _, err := svc.ListMemberSuggestions(context.Background(), super, MemberSuggestionsInput{Vendor: "Acme"}); err != nil {
		t.Fatalf("super: unexpected error: %v", err)
	}
	if !repo.lastMember.IsGlobal || repo.lastMember.VendorName != "Acme" {
		t.Fatalf("super filter = %+v, want global + vendor narrow", repo.lastMember)
	}
}

func TestListMemberSuggestionsAdminOutOfScopeAbsent(t *testing.T) {
	repo := &fakeSuggestionRepo{memberRows: []scopedMemberRow{
		{location: "loc-A", suggestion: domain.MemberSuggestion{Name: "Andi", Phone: "0811", VisitorID: "visitor-a", SourceVisitID: "visit-a"}},
		{location: "loc-B", suggestion: domain.MemberSuggestion{Name: "Budi", Phone: "0812", VisitorID: "visitor-b", SourceVisitID: "visit-b"}},
	}}
	svc := newSuggestionService(newFakeVisitRepo(t), repo)
	actor := testActor(domain.RoleAdmin, "admin-1", "loc-A")
	actor.Branches = []domain.UUID{"loc-A"}

	got, err := svc.ListMemberSuggestions(context.Background(), actor, MemberSuggestionsInput{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 1 || got[0].Name != "Andi" {
		t.Fatalf("got %+v, want only the in-scope Andi", got)
	}
	if got[0].VisitorID != "visitor-a" {
		t.Fatalf("visitor id = %q, want the fixture row id visitor-a", got[0].VisitorID)
	}
}

func TestGetMemberSuggestionOutOfScopeIsNotFound(t *testing.T) {
	visitRepo := newFakeVisitRepo(t)
	seedVisit(visitRepo, domain.VisitRequest{
		ID: "visit-b", VisitID: "VST-0000000002", VendorUserID: "vendor-1",
		LocationID: "loc-B", Status: domain.VisitStatusApproved,
	})
	repo := &fakeSuggestionRepo{visitor: domain.Visitor{
		ID: "visitor-1", VisitRequestID: "visit-b", Name: "Budi", Phone: "0812",
	}}
	svc := newSuggestionService(visitRepo, repo)
	actor := testActor(domain.RoleAdmin, "admin-1", "loc-A")
	actor.Branches = []domain.UUID{"loc-A"}

	if _, err := svc.GetMemberSuggestion(context.Background(), actor, "visitor-1"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("cross-branch pick: err = %v, want not found", err)
	}
}

func TestGetMemberSuggestionVendorOwnershipIsNotFound(t *testing.T) {
	visitRepo := newFakeVisitRepo(t)
	seedVisit(visitRepo, domain.VisitRequest{
		ID: "visit-a", VisitID: "VST-0000000001", VendorUserID: "vendor-1",
		LocationID: "loc-A", Status: domain.VisitStatusApproved,
	})
	repo := &fakeSuggestionRepo{visitor: domain.Visitor{
		ID: "visitor-1", VisitRequestID: "visit-a", Name: "Andi", Phone: "0811",
	}}
	svc := newSuggestionService(visitRepo, repo)

	if _, err := svc.GetMemberSuggestion(context.Background(), testActor(domain.RoleVendor, "vendor-2", ""), "visitor-1"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("foreign vendor pick: err = %v, want not found", err)
	}
}

func TestGetMemberSuggestionPresignsPhotos(t *testing.T) {
	visitRepo := newFakeVisitRepo(t)
	seedVisit(visitRepo, domain.VisitRequest{
		ID: "visit-a", VisitID: "VST-0000000001", VendorUserID: "vendor-1",
		LocationID: "loc-A", Status: domain.VisitStatusApproved,
	})
	ktp := presignTestBase + "/id_cards/visitor-1/ktp.jpg"
	selfie := presignTestBase + "/id_cards/visitor-1/selfie.jpg"
	repo := &fakeSuggestionRepo{visitor: domain.Visitor{
		ID: "visitor-1", VisitRequestID: "visit-a", Name: "Andi", Phone: "0811",
		VendorName:     "  PT Alpha  ",
		IDCardPhotoURL: &ktp, PhotoURL: &selfie,
	}}
	storage := &fakeFileStorage{}
	svc := newSuggestionService(visitRepo, repo).WithFileLinks(storage, time.Minute)
	actor := testActor(domain.RoleAdmin, "admin-1", "loc-A")
	actor.Branches = []domain.UUID{"loc-A"}

	got, err := svc.GetMemberSuggestion(context.Background(), actor, "visitor-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.IDCardPhotoURL == nil || !strings.HasPrefix(*got.IDCardPhotoURL, "https://signed.example/") {
		t.Fatalf("KTP link = %v, want presigned", got.IDCardPhotoURL)
	}
	if got.PhotoURL == nil || !strings.HasPrefix(*got.PhotoURL, "https://signed.example/") {
		t.Fatalf("selfie link = %v, want presigned", got.PhotoURL)
	}
	if got.SourceVisitID != "visit-a" {
		t.Fatalf("source visit = %q, want visit-a", got.SourceVisitID)
	}
	if got.VendorName == nil || *got.VendorName != "PT Alpha" {
		t.Fatalf("vendor name = %v, want the trimmed member company PT Alpha", got.VendorName)
	}
	if storage.signCalls != 2 {
		t.Fatalf("presign calls = %d, want 2", storage.signCalls)
	}
}

func TestGetMemberSuggestionBlankVendorNameIsNil(t *testing.T) {
	visitRepo := newFakeVisitRepo(t)
	seedVisit(visitRepo, domain.VisitRequest{
		ID: "visit-a", VisitID: "VST-0000000001", VendorUserID: "vendor-1",
		LocationID: "loc-A", Status: domain.VisitStatusApproved,
	})
	repo := &fakeSuggestionRepo{visitor: domain.Visitor{
		ID: "visitor-1", VisitRequestID: "visit-a", Name: "Andi", Phone: "0811",
		VendorName: "   ",
	}}
	svc := newSuggestionService(visitRepo, repo)
	actor := testActor(domain.RoleAdmin, "admin-1", "loc-A")
	actor.Branches = []domain.UUID{"loc-A"}

	got, err := svc.GetMemberSuggestion(context.Background(), actor, "visitor-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.VendorName != nil {
		t.Fatalf("vendor name = %q, want nil for a blank member company", *got.VendorName)
	}
	if got.SourceVisitID != "visit-a" {
		t.Fatalf("source visit = %q, want visit-a", got.SourceVisitID)
	}
}

func TestGetMemberSuggestionUnknownVisitorIsNotFound(t *testing.T) {
	repo := &fakeSuggestionRepo{visitorErr: domain.ErrNotFound}
	svc := newSuggestionService(newFakeVisitRepo(t), repo)

	if _, err := svc.GetMemberSuggestion(context.Background(), testActor(domain.RoleSuperAdmin, "super-1", ""), "missing"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("unknown visitor: err = %v, want not found", err)
	}
}
