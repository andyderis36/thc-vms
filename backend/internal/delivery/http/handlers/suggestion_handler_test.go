package handlers_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/handlers"
	"thc-vms/backend/internal/domain"
)

func newSuggestionEngine(svc *fakeVisitService, role domain.RoleName, loc string) *gin.Engine {
	engine := gin.New()
	engine.Use(withActor(role, loc))
	h := handlers.NewVisitHandler(svc)
	engine.GET("/vendors/suggestions", h.ListVendorSuggestions)
	engine.GET("/visits/member-suggestions", h.ListMemberSuggestions)
	engine.GET("/visits/member-suggestions/:visitorId", h.GetMemberSuggestion)
	return engine
}

func TestVendorSuggestionsForbiddenPropagates(t *testing.T) {
	svc := &fakeVisitService{vendorSuggestionsErr: domain.ForbiddenBranch()}
	engine := newSuggestionEngine(svc, domain.RoleVendor, "")

	rec := serve(engine, "GET", "/vendors/suggestions", nil, "")
	mustStatus(t, rec, 403)
	env := decodeEnvelope(t, rec)
	if env.Error == nil || env.Error.Code != "FORBIDDEN_BRANCH" {
		t.Fatalf("error = %+v, want FORBIDDEN_BRANCH", env.Error)
	}
}

func TestMemberSuggestionsForbiddenPropagates(t *testing.T) {
	svc := &fakeVisitService{memberSuggestionsErr: domain.ForbiddenBranch()}
	engine := newSuggestionEngine(svc, domain.RoleSecurity, "loc-A")

	rec := serve(engine, "GET", "/visits/member-suggestions", nil, "")
	mustStatus(t, rec, 403)
	env := decodeEnvelope(t, rec)
	if env.Error == nil || env.Error.Code != "FORBIDDEN_BRANCH" {
		t.Fatalf("error = %+v, want FORBIDDEN_BRANCH", env.Error)
	}
}

func TestMemberSuggestionsListIsPhotoLess(t *testing.T) {
	email, jabatan := "andi@example.com", "Teknisi"
	svc := &fakeVisitService{memberSuggestions: []domain.MemberSuggestion{{
		Name: "Andi", IDNumber: "ID123", Phone: "0811",
		Email: &email, Jabatan: &jabatan,
		LastVisitAt: cannedVisit().StartDate,
		VisitorID:   "22222222-2222-2222-2222-222222222222", SourceVisitID: "visit-1",
	}}}
	engine := newSuggestionEngine(svc, domain.RoleAdmin, "loc-A")

	rec := serve(engine, "GET", "/visits/member-suggestions", nil, "")
	mustStatus(t, rec, 200)
	env := mustSuccess(t, rec)

	var items []map[string]json.RawMessage
	if err := json.Unmarshal(env.Data, &items); err != nil {
		t.Fatalf("data is not an array: %v: %q", err, string(env.Data))
	}
	if len(items) != 1 {
		t.Fatalf("got %d items, want 1", len(items))
	}
	for _, forbidden := range []string{"id_card_photo_url", "photo_url"} {
		if _, ok := items[0][forbidden]; ok {
			t.Fatalf("member list leaked %q: %q", forbidden, string(env.Data))
		}
	}
	for _, required := range []string{"name", "id_number", "phone", "email", "jabatan", "last_visit_at", "visitor_id", "source_visit_id"} {
		if _, ok := items[0][required]; !ok {
			t.Fatalf("member list missing %q: %q", required, string(env.Data))
		}
	}
	if got := string(items[0]["visitor_id"]); got != `"22222222-2222-2222-2222-222222222222"` {
		t.Fatalf("visitor_id = %s, want the row id", got)
	}
}

func TestSuggestionQueryOverCapReturnsValidationError(t *testing.T) {
	long := strings.Repeat("a", 81)
	for _, path := range []string{"/vendors/suggestions?q=" + long, "/visits/member-suggestions?q=" + long} {
		svc := &fakeVisitService{}
		engine := newSuggestionEngine(svc, domain.RoleSuperAdmin, "")

		rec := serve(engine, "GET", path, nil, "")
		mustStatus(t, rec, 400)
		env := decodeEnvelope(t, rec)
		if env.Error == nil || env.Error.Code != "VALIDATION_ERROR" {
			t.Fatalf("%s: error = %+v, want VALIDATION_ERROR", path, env.Error)
		}
		if svc.lastVendorQuery != "" || svc.lastMemberIn.Query != "" {
			t.Fatalf("%s: usecase was called with an oversized q", path)
		}
	}
}

func TestMemberSuggestionsForwardsTrimmedFilters(t *testing.T) {
	svc := &fakeVisitService{}
	engine := newSuggestionEngine(svc, domain.RoleAdmin, "loc-A")

	rec := serve(engine, "GET", "/visits/member-suggestions?q=%20andi%20&vendor=%20Acme%20", nil, "")
	mustStatus(t, rec, 200)
	if svc.lastMemberIn.Query != "andi" || svc.lastMemberIn.Vendor != "Acme" {
		t.Fatalf("forwarded input = %+v, want trimmed q/vendor", svc.lastMemberIn)
	}
}

func TestMemberSuggestionPickReturnsPhotoKeys(t *testing.T) {
	ktp := "https://signed.example/ktp.jpg"
	selfie := "https://signed.example/selfie.jpg"
	vendorName := "PT Alpha"
	svc := &fakeVisitService{memberDetail: domain.MemberSuggestionDetail{
		Name: "Andi", IDNumber: "ID123", Phone: "0811",
		VendorName:     &vendorName,
		IDCardPhotoURL: &ktp, PhotoURL: &selfie, SourceVisitID: "visit-1",
	}}
	engine := newSuggestionEngine(svc, domain.RoleAdmin, "loc-A")

	rec := serve(engine, "GET", "/visits/member-suggestions/11111111-1111-1111-1111-111111111111", nil, "")
	mustStatus(t, rec, 200)
	env := mustSuccess(t, rec)
	var item map[string]json.RawMessage
	if err := json.Unmarshal(env.Data, &item); err != nil {
		t.Fatalf("data is not an object: %v: %q", err, string(env.Data))
	}
	for _, key := range []string{"name", "id_number", "phone", "email", "jabatan", "vendor_name", "id_card_photo_url", "photo_url", "source_visit_id"} {
		if _, ok := item[key]; !ok {
			t.Fatalf("pick response missing %q: %q", key, string(env.Data))
		}
	}
	if got := string(item["vendor_name"]); got != `"PT Alpha"` {
		t.Fatalf("vendor_name = %s, want the member's own company", got)
	}
	if svc.lastMemberVisitor != "11111111-1111-1111-1111-111111111111" {
		t.Fatalf("visitor id = %q, want 11111111-1111-1111-1111-111111111111", svc.lastMemberVisitor)
	}
}

func TestMemberSuggestionPickBlankVendorNameIsNull(t *testing.T) {
	svc := &fakeVisitService{memberDetail: domain.MemberSuggestionDetail{
		Name: "Andi", IDNumber: "ID123", Phone: "0811", SourceVisitID: "visit-1",
	}}
	engine := newSuggestionEngine(svc, domain.RoleAdmin, "loc-A")

	rec := serve(engine, "GET", "/visits/member-suggestions/11111111-1111-1111-1111-111111111111", nil, "")
	mustStatus(t, rec, 200)
	env := mustSuccess(t, rec)
	var item map[string]json.RawMessage
	if err := json.Unmarshal(env.Data, &item); err != nil {
		t.Fatalf("data is not an object: %v: %q", err, string(env.Data))
	}
	raw, ok := item["vendor_name"]
	if !ok {
		t.Fatalf("pick response missing vendor_name: %q", string(env.Data))
	}
	if string(raw) != "null" {
		t.Fatalf("vendor_name = %s, want null when the member has no company", raw)
	}
}

func TestMemberSuggestionPickMalformedIDIsNotFound(t *testing.T) {
	svc := &fakeVisitService{}
	engine := newSuggestionEngine(svc, domain.RoleAdmin, "loc-A")

	for _, path := range []string{"/visits/member-suggestions/not-a-uuid", "/visits/member-suggestions/%20"} {
		rec := serve(engine, "GET", path, nil, "")
		mustStatus(t, rec, 404)
	}
	if svc.lastMemberVisitor != "" {
		t.Fatal("a malformed visitor id must not reach the usecase")
	}
}

func TestMemberSuggestionPickOutOfScopeIsNotFound(t *testing.T) {
	svc := &fakeVisitService{memberDetailErr: domain.NotFoundEntity("Anggota")}
	engine := newSuggestionEngine(svc, domain.RoleAdmin, "loc-A")

	rec := serve(engine, "GET", "/visits/member-suggestions/11111111-1111-1111-1111-111111111111", nil, "")
	mustStatus(t, rec, 404)
}
