package handlers_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/handlers"
	"thc-vms/backend/internal/domain"
)

func newVisitEngine(svc *fakeVisitService, role domain.RoleName, loc string) *gin.Engine {
	engine := gin.New()
	engine.Use(withActor(role, loc))
	h := handlers.NewVisitHandler(svc)
	engine.GET("/visits", h.List)
	engine.POST("/visits", h.Create)
	engine.GET("/visits/:id", h.Get)
	engine.POST("/visits/:id/approve", h.Approve)
	engine.POST("/visits/:id/reject", h.Reject)
	engine.POST("/visits/:id/reschedule", h.Reschedule)
	engine.POST("/visits/:id/cancel", h.Cancel)
	engine.GET("/visits/:id/qr", h.QR)
	return engine
}

func TestListVisits_ReturnsItemsTotalPageLimit(t *testing.T) {
	svc := &fakeVisitService{
		listItems: []domain.VisitRequest{cannedVisit(), cannedVisit()},
		listTotal: 42,
	}
	engine := newVisitEngine(svc, domain.RoleSuperAdmin, "")

	rec := serve(engine, "GET", "/visits?page=2&limit=2", nil, "")
	mustStatus(t, rec, 200)
	env := mustSuccess(t, rec)

	// The data member must be an OBJECT with the four envelope keys,
	// never a bare array.
	var data map[string]json.RawMessage
	if err := json.Unmarshal(env.Data, &data); err != nil {
		t.Fatalf("list data is not an object (bare array?): %v: %q", err, string(env.Data))
	}
	for _, key := range []string{"items", "total", "page", "limit"} {
		if _, ok := data[key]; !ok {
			t.Fatalf("list data missing key %q: %q", key, string(env.Data))
		}
	}
	var page struct {
		Items []map[string]any `json:"items"`
		Total int64            `json:"total"`
		Page  int              `json:"page"`
		Limit int              `json:"limit"`
	}
	if err := json.Unmarshal(env.Data, &page); err != nil {
		t.Fatalf("list data shape wrong: %v", err)
	}
	if page.Total != 42 || page.Page != 2 || page.Limit != 2 {
		t.Fatalf("got total=%d page=%d limit=%d, want 42/2/2", page.Total, page.Page, page.Limit)
	}
	if len(page.Items) != 2 {
		t.Fatalf("got %d items, want 2", len(page.Items))
	}
	if svc.lastListIn.Page != 2 || svc.lastListIn.Limit != 2 {
		t.Fatalf("usecase got page=%d limit=%d, want 2/2", svc.lastListIn.Page, svc.lastListIn.Limit)
	}
}

func TestListVisits_DefaultsPageAndLimit(t *testing.T) {
	svc := &fakeVisitService{}
	engine := newVisitEngine(svc, domain.RoleAdmin, "loc-A")

	rec := serve(engine, "GET", "/visits", nil, "")
	mustStatus(t, rec, 200)
	env := mustSuccess(t, rec)
	var page struct {
		Page  int `json:"page"`
		Limit int `json:"limit"`
	}
	if err := json.Unmarshal(env.Data, &page); err != nil {
		t.Fatalf("list data shape wrong: %v", err)
	}
	if page.Page != 1 || page.Limit != 10 {
		t.Fatalf("got page=%d limit=%d, want defaults 1/10", page.Page, page.Limit)
	}
}

func TestGetVisit_ResolvesBothUUIDAndVisitCode(t *testing.T) {
	v := cannedVisit()
	svc := &fakeVisitService{visitByKey: map[string]domain.VisitRequest{
		"visit-1":        v,
		"VST-0000000001": v,
	}}
	engine := newVisitEngine(svc, domain.RoleAdmin, "loc-A")

	recUUID := serve(engine, "GET", "/visits/visit-1", nil, "")
	mustStatus(t, recUUID, 200)
	envUUID := mustSuccess(t, recUUID)

	recCode := serve(engine, "GET", "/visits/VST-0000000001", nil, "")
	mustStatus(t, recCode, 200)
	envCode := mustSuccess(t, recCode)

	var gotUUID, gotCode map[string]any
	if err := json.Unmarshal(envUUID.Data, &gotUUID); err != nil {
		t.Fatalf("uuid detail broken: %v", err)
	}
	if err := json.Unmarshal(envCode.Data, &gotCode); err != nil {
		t.Fatalf("code detail broken: %v", err)
	}
	if gotUUID["visit_id"] != "VST-0000000001" || gotCode["visit_id"] != "VST-0000000001" {
		t.Fatalf("visit_id mismatch: uuid=%v code=%v", gotUUID["visit_id"], gotCode["visit_id"])
	}
}

func TestCreateVisit_Returns201WithDetail(t *testing.T) {
	svc := &fakeVisitService{}
	engine := newVisitEngine(svc, domain.RoleVendor, "")

	payload := `{
		"location_id": "11111111-1111-1111-1111-111111111111",
		"purpose_ids": ["22222222-2222-2222-2222-222222222222"],
		"start_date": "2026-10-01T09:00:00Z",
		"end_date": "2026-10-01T17:00:00Z",
		"is_nda_accepted": true,
		"notes": "splicing FO",
		"assignment_letter_url": "http://localhost:9000/thc-vms-bucket/assignment_letters/visit-1/spk.pdf",
		"visitors": [{"name": "Andi", "id_number": "ID123", "phone": "0811"}]
	}`
	rec := serveJSON(engine, "POST", "/visits", payload)
	mustStatus(t, rec, 201)
	env := mustSuccess(t, rec)
	var detail map[string]any
	if err := json.Unmarshal(env.Data, &detail); err != nil {
		t.Fatalf("create detail broken: %v", err)
	}
	if detail["visit_id"] != "VST-0000000001" {
		t.Fatalf("visit_id = %v, want VST-0000000001", detail["visit_id"])
	}
	if len(svc.lastCreateIn.Visitors) != 1 || len(svc.lastCreateIn.PurposeIDs) != 1 {
		t.Fatalf("usecase input not mapped: %+v", svc.lastCreateIn)
	}
}

// TestCreateVisit_EchoMatchesGetDetail pins the 201 echo contract: the create
// response must carry the same enriched members as GET /visits/{id} (location
// name, vendor_user name/email, vendor_name, named purposes, roster, SPK URL),
// minus the gate times which belong to the single-GET path only.
func TestCreateVisit_EchoMatchesGetDetail(t *testing.T) {
	enriched := cannedVisit()
	enriched.Purposes = []domain.Purpose{
		{ID: "22222222-2222-2222-2222-222222222222", Name: "Splicing FO", IsActive: true},
	}
	// The repository returns the bare row on create (no join names, no
	// purposes); the handler must re-read via the GET path before answering
	// 201 so the echo is as complete as a GET.
	bare := domain.VisitRequest{
		ID:           enriched.ID,
		VisitID:      enriched.VisitID,
		VendorUserID: enriched.VendorUserID,
		LocationID:   enriched.LocationID,
		Status:       domain.VisitStatusRequested,
		StartDate:    enriched.StartDate,
		EndDate:      enriched.EndDate,
		CreatedAt:    enriched.CreatedAt,
		Visitors:     enriched.Visitors,
	}
	svc := &fakeVisitService{
		created:    bare,
		visitByKey: map[string]domain.VisitRequest{string(bare.ID): enriched},
	}
	engine := newVisitEngine(svc, domain.RoleVendor, "")

	payload := `{
		"location_id": "loc-A",
		"purpose_ids": ["22222222-2222-2222-2222-222222222222"],
		"start_date": "2026-10-01T09:00:00Z",
		"end_date": "2026-10-01T17:00:00Z",
		"is_nda_accepted": true,
		"notes": "splicing FO",
		"assignment_letter_url": "http://localhost:9000/thc-vms-bucket/assignment_letters/visit-1/spk.pdf",
		"visitors": [{"name": "Andi", "id_number": "ID123", "phone": "0811"}]
	}`
	rec := serveJSON(engine, "POST", "/visits", payload)
	mustStatus(t, rec, 201)
	detail := asObject(t, mustSuccess(t, rec).Data)

	loc, ok := detail["location"].(map[string]any)
	if !ok || loc == nil {
		t.Fatalf("location missing in 201 echo: %v", detail["location"])
	}
	if loc["name"] != "POP Tebet" {
		t.Fatalf("location.name = %v, want POP Tebet (echo selengkap GET)", loc["name"])
	}
	user, ok := detail["pic_user"].(map[string]any)
	if !ok || user == nil {
		t.Fatalf("pic_user missing in 201 echo: %v", detail["pic_user"])
	}
	if user["name"] != "Dimas Prasetyo" {
		t.Fatalf("pic_user.name = %v, want Dimas Prasetyo", user["name"])
	}
	if user["email"] != "dimas@vendor.example" {
		t.Fatalf("pic_user.email = %v, want dimas@vendor.example", user["email"])
	}
	if detail["vendor_name"] != "PT Lintas Fiber" {
		t.Fatalf("vendor_name = %v, want PT Lintas Fiber", detail["vendor_name"])
	}
	purposes, ok := detail["purposes"].([]any)
	if !ok || len(purposes) != 1 {
		t.Fatalf("purposes echo wrong: %v", detail["purposes"])
	}
	purpose := purposes[0].(map[string]any)
	if purpose["id"] != "22222222-2222-2222-2222-222222222222" {
		t.Fatalf("purpose.id = %v, want the catalogue id", purpose["id"])
	}
	if purpose["name"] != "Splicing FO" {
		t.Fatalf("purpose.name = %v, want Splicing FO (bukan shell ID-only)", purpose["name"])
	}
	visitors, ok := detail["visitors"].([]any)
	if !ok || len(visitors) != 1 {
		t.Fatalf("visitors echo wrong: %v", detail["visitors"])
	}
	if visitors[0].(map[string]any)["name"] != "Andi" {
		t.Fatalf("roster name = %v, want Andi", visitors[0].(map[string]any)["name"])
	}
	if detail["assignment_letter_url"] != "http://localhost:9000/thc-vms-bucket/assignment_letters/visit-1/spk.pdf" {
		t.Fatalf("assignment_letter_url = %v, want the SPK URL", detail["assignment_letter_url"])
	}
	if _, hasCheckIn := detail["check_in_at"]; hasCheckIn {
		t.Fatalf("201 echo must not carry gate times, got %v", detail["check_in_at"])
	}
}

func TestCreateVisit_MapsPerVisitorVendorIDAndPhotoURL(t *testing.T) {
	created := cannedVisit()
	created.Visitors = []domain.Visitor{{
		ID: "visitor-1", VisitRequestID: "visit-1",
		Name: "Andi", IDNumber: "ID123", Phone: "0811",
		PhotoURL:   strPtr("http://localhost:9000/b/id_card/visit-1/selfie.jpg"),
		VendorID:   "33333333-3333-3333-3333-333333333333",
		VendorName: "PT Lintas Fiber",
	}}
	svc := &fakeVisitService{created: created}
	engine := newVisitEngine(svc, domain.RoleVendor, "")

	payload := `{
		"location_id": "11111111-1111-1111-1111-111111111111",
		"purpose_ids": ["22222222-2222-2222-2222-222222222222"],
		"start_date": "2026-10-01T09:00:00Z",
		"end_date": "2026-10-01T17:00:00Z",
		"is_nda_accepted": true,
		"assignment_letter_url": "http://localhost:9000/thc-vms-bucket/assignment_letters/visit-1/spk.pdf",
		"visitors": [{"name": "Andi", "id_number": "ID123", "phone": "0811", "photo_url": "http://localhost:9000/b/id_card/visit-1/selfie.jpg", "vendor_id": "33333333-3333-3333-3333-333333333333"}]
	}`
	rec := serveJSON(engine, "POST", "/visits", payload)
	mustStatus(t, rec, 201)
	if len(svc.lastCreateIn.Visitors) != 1 || svc.lastCreateIn.Visitors[0].VendorID == nil ||
		string(*svc.lastCreateIn.Visitors[0].VendorID) != "33333333-3333-3333-3333-333333333333" {
		t.Fatalf("usecase per-visitor vendor not mapped: %+v", svc.lastCreateIn.Visitors)
	}
	if len(svc.lastCreateIn.Visitors) != 1 || svc.lastCreateIn.Visitors[0].PhotoURL == nil {
		t.Fatalf("usecase selfie not mapped: %+v", svc.lastCreateIn.Visitors)
	}
	env := mustSuccess(t, rec)
	var detail map[string]any
	if err := json.Unmarshal(env.Data, &detail); err != nil {
		t.Fatalf("create detail broken: %v", err)
	}
	visitors, ok := detail["visitors"].([]any)
	if !ok || len(visitors) != 1 {
		t.Fatalf("visitors echo wrong: %v", detail["visitors"])
	}
	echo := visitors[0].(map[string]any)
	if echo["photo_url"] != "http://localhost:9000/b/id_card/visit-1/selfie.jpg" {
		t.Fatalf("photo_url not echoed: %v", echo)
	}
	if echo["vendor_id"] != "33333333-3333-3333-3333-333333333333" {
		t.Fatalf("vendor_id not echoed: %v", echo)
	}
	if echo["vendor_name"] != "PT Lintas Fiber" {
		t.Fatalf("vendor_name not resolved: %v", echo)
	}
}

func TestCreateVisit_RejectsMalformedPerVisitorVendorID(t *testing.T) {
	svc := &fakeVisitService{}
	engine := newVisitEngine(svc, domain.RoleVendor, "")

	payload := `{
		"location_id": "11111111-1111-1111-1111-111111111111",
		"purpose_ids": ["22222222-2222-2222-2222-222222222222"],
		"start_date": "2026-10-01T09:00:00Z",
		"end_date": "2026-10-01T17:00:00Z",
		"is_nda_accepted": true,
		"assignment_letter_url": "http://localhost:9000/thc-vms-bucket/assignment_letters/visit-1/spk.pdf",
		"visitors": [{"name": "Andi", "id_number": "ID123", "phone": "0811", "vendor_id": "bukan-uuid"}]
	}`
	rec := serveJSON(engine, "POST", "/visits", payload)
	mustStatus(t, rec, 400)
}

func TestGetVisit_RendersVendorNameAndVisitorPhoto(t *testing.T) {
	v := cannedVisit()
	svc := &fakeVisitService{visitByKey: map[string]domain.VisitRequest{"visit-1": v}}
	engine := newVisitEngine(svc, domain.RoleAdmin, "loc-A")

	rec := serve(engine, "GET", "/visits/visit-1", nil, "")
	mustStatus(t, rec, 200)
	detail := asObject(t, mustSuccess(t, rec).Data)
	if detail["vendor_name"] != "PT Lintas Fiber" {
		t.Fatalf("vendor_name = %v, want PT Lintas Fiber", detail["vendor_name"])
	}
	visitors, ok := detail["visitors"].([]any)
	if !ok || len(visitors) != 1 {
		t.Fatalf("visitors wrong: %v", detail["visitors"])
	}
	visitor := visitors[0].(map[string]any)
	if visitor["photo_url"] != "http://localhost:9000/thc-vms-bucket/id_card/visit-1/selfie.jpg" {
		t.Fatalf("photo_url = %v, want the selfie URL", visitor["photo_url"])
	}
	if visitor["vendor_id"] != "vendor-1" {
		t.Fatalf("vendor_id = %v, want vendor-1", visitor["vendor_id"])
	}
	if visitor["vendor_name"] != "PT Lintas Fiber" {
		t.Fatalf("vendor_name = %v, want PT Lintas Fiber", visitor["vendor_name"])
	}
}

func TestReject_RequiresFiveCharacterReason(t *testing.T) {
	svc := &fakeVisitService{}
	engine := newVisitEngine(svc, domain.RoleAdmin, "loc-A")

	rec := serveJSON(engine, "POST", "/visits/visit-1/reject", `{"reason": "abcd"}`)
	mustStatus(t, rec, 400)

	rec = serveJSON(engine, "POST", "/visits/visit-1/reject", `{"reason": "abcde"}`)
	mustStatus(t, rec, 200)
	if svc.lastReason != "abcde" {
		t.Fatalf("usecase reason = %q, want abcde", svc.lastReason)
	}
}

func TestReschedule_RequiresAllThreeFields(t *testing.T) {
	cases := map[string]string{
		"missing start": `{"end_date": "2026-10-02T17:00:00Z", "reason": "jadwal molor"}`,
		"missing end":   `{"start_date": "2026-10-02T09:00:00Z", "reason": "jadwal molor"}`,
		"missing notes": `{"start_date": "2026-10-02T09:00:00Z", "end_date": "2026-10-02T17:00:00Z"}`,
	}
	for name, payload := range cases {
		t.Run(name, func(t *testing.T) {
			svc := &fakeVisitService{}
			engine := newVisitEngine(svc, domain.RoleVendor, "")
			rec := serveJSON(engine, "POST", "/visits/visit-1/reschedule", payload)
			mustStatus(t, rec, 400)
		})
	}

	svc := &fakeVisitService{}
	engine := newVisitEngine(svc, domain.RoleVendor, "")
	rec := serveJSON(engine, "POST", "/visits/visit-1/reschedule",
		`{"start_date": "2026-10-02T09:00:00Z", "end_date": "2026-10-02T17:00:00Z", "reason": "jadwal molor"}`)
	mustStatus(t, rec, 200)
	if svc.lastResReason != "jadwal molor" {
		t.Fatalf("usecase reason = %q", svc.lastResReason)
	}
}

func TestApproveAndCancel_Smoke(t *testing.T) {
	svc := &fakeVisitService{}
	engine := newVisitEngine(svc, domain.RoleAdmin, "loc-A")

	rec := serveJSON(engine, "POST", "/visits/visit-1/approve", `{"notes": "ok"}`)
	mustStatus(t, rec, 200)
	if string(svc.lastApproveID) != "visit-1" {
		t.Fatalf("approve id = %q", svc.lastApproveID)
	}

	rec = serveJSON(engine, "POST", "/visits/visit-1/cancel", `{}`)
	mustStatus(t, rec, 200)
	if string(svc.lastCancelID) != "visit-1" {
		t.Fatalf("cancel id = %q", svc.lastCancelID)
	}
}

func TestListVisits_RendersLocationNameAndType(t *testing.T) {
	svc := &fakeVisitService{
		listItems: []domain.VisitRequest{cannedVisit()},
		listTotal: 1,
	}
	engine := newVisitEngine(svc, domain.RoleSuperAdmin, "")

	rec := serve(engine, "GET", "/visits", nil, "")
	mustStatus(t, rec, 200)
	data := asObject(t, mustSuccess(t, rec).Data)
	items, ok := data["items"].([]any)
	if !ok || len(items) != 1 {
		t.Fatalf("items wrong: %v", data["items"])
	}
	detail := items[0].(map[string]any)
	loc, ok := detail["location"].(map[string]any)
	if !ok || loc == nil {
		t.Fatalf("location missing: %v", detail["location"])
	}
	assertSubset(t, "Location", loc)
	if loc["id"] != "loc-A" {
		t.Fatalf("location.id = %v, want loc-A", loc["id"])
	}
	if loc["name"] != "POP Tebet" {
		t.Fatalf("location.name = %v, want POP Tebet", loc["name"])
	}
	if loc["type"] != "pop" {
		t.Fatalf("location.type = %v, want pop", loc["type"])
	}
}

func TestListVisits_RendersVendorUserNameAndEmail(t *testing.T) {
	svc := &fakeVisitService{
		listItems: []domain.VisitRequest{cannedVisit()},
		listTotal: 1,
	}
	engine := newVisitEngine(svc, domain.RoleSuperAdmin, "")

	rec := serve(engine, "GET", "/visits", nil, "")
	mustStatus(t, rec, 200)
	data := asObject(t, mustSuccess(t, rec).Data)
	items, ok := data["items"].([]any)
	if !ok || len(items) != 1 {
		t.Fatalf("items wrong: %v", data["items"])
	}
	detail := items[0].(map[string]any)
	user, ok := detail["pic_user"].(map[string]any)
	if !ok || user == nil {
		t.Fatalf("pic_user missing: %v", detail["pic_user"])
	}
	assertSubset(t, "User", user)
	if user["id"] != "vendor-1" {
		t.Fatalf("pic_user.id = %v, want vendor-1", user["id"])
	}
	if user["name"] != "Dimas Prasetyo" {
		t.Fatalf("pic_user.name = %v, want Dimas Prasetyo", user["name"])
	}
	if user["email"] != "dimas@vendor.example" {
		t.Fatalf("pic_user.email = %v, want dimas@vendor.example", user["email"])
	}
}

func TestGetVisit_RendersVendorUserNameAndEmail(t *testing.T) {
	svc := &fakeVisitService{
		visitByKey: map[string]domain.VisitRequest{"visit-1": cannedVisit()},
	}
	engine := newVisitEngine(svc, domain.RoleSuperAdmin, "")

	rec := serve(engine, "GET", "/visits/visit-1", nil, "")
	mustStatus(t, rec, 200)
	detail := asObject(t, mustSuccess(t, rec).Data)
	user, ok := detail["pic_user"].(map[string]any)
	if !ok || user == nil {
		t.Fatalf("pic_user missing: %v", detail["pic_user"])
	}
	assertSubset(t, "User", user)
	if user["name"] != "Dimas Prasetyo" {
		t.Fatalf("pic_user.name = %v, want Dimas Prasetyo", user["name"])
	}
	if user["email"] != "dimas@vendor.example" {
		t.Fatalf("pic_user.email = %v, want dimas@vendor.example", user["email"])
	}
}

func TestQR_ReturnsVisitIDAndPayloadEqualToVisitID(t *testing.T) {
	svc := &fakeVisitService{}
	engine := newVisitEngine(svc, domain.RoleVendor, "")

	rec := serve(engine, "GET", "/visits/visit-1/qr", nil, "")
	mustStatus(t, rec, 200)
	env := mustSuccess(t, rec)

	var qr map[string]json.RawMessage
	if err := json.Unmarshal(env.Data, &qr); err != nil {
		t.Fatalf("qr data is not an object: %v", err)
	}
	if len(qr) != 2 {
		keys := make([]string, 0, len(qr))
		for k := range qr {
			keys = append(keys, k)
		}
		t.Fatalf("qr data must have exactly two keys, got %v", keys)
	}
	var visitID, payload string
	if err := json.Unmarshal(qr["visit_id"], &visitID); err != nil {
		t.Fatalf("visit_id missing/not a string: %q", string(env.Data))
	}
	if err := json.Unmarshal(qr["qr_code_payload"], &payload); err != nil {
		t.Fatalf("qr_code_payload missing/not a string: %q", string(env.Data))
	}
	if visitID != "VST-0000000001" || payload != visitID {
		t.Fatalf("visit_id=%q payload=%q, want payload == visit_id == VST-0000000001", visitID, payload)
	}
	if strings.Contains(string(env.Data), "format") {
		t.Fatalf("qr data must not carry a format field: %q", string(env.Data))
	}
}
