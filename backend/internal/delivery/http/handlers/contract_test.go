package handlers_test

import (
	"encoding/json"
	"sort"
	"testing"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/handlers"
	"thc-vms/backend/internal/domain"
)

// openapiKeys mirrors docs/4. openapi.yaml L770-913: the exact key vocabulary
// each schema allows. A handler emitting any other key fails this test.
var openapiKeys = map[string]map[string]bool{
	"VisitorItem": {
		"id": true, "name": true, "id_number": true, "phone": true, "id_card_photo_url": true,
		"photo_url": true, "vendor_id": true, "vendor_name": true, "jabatan": true,
		"email": true, "phone_edited": true,
	},
	"Location": {
		"id": true, "name": true, "type": true, "address": true,
		"city": true, "timezone": true, "is_active": true,
	},
	"Purpose": {"id": true, "name": true, "is_active": true},
	"User": {
		"id": true, "name": true, "email": true, "phone": true, "nik": true, "role": true,
		"location_id": true, "location_ids": true, "location_name": true, "status": true,
		"type": true, "vendor_name": true, "avatar_url": true, "editable_fields": true,
	},
	"VisitDetail": {
		"id": true, "visit_id": true, "status": true, "location": true,
		"purposes": true, "vendor_user": true, "pic_user": true, "vendor_name": true,
		"start_date": true, "end_date": true, "assignment_letter_url": true,
		"notes": true, "purpose_note": true, "status_note": true, "visitors": true, "created_at": true,
		"check_in_at": true, "check_out_at": true, "checked_in_by": true,
		"created_by": true, "created_by_name": true, "created_by_role_label": true,
		"checked_in_by_name": true, "checked_out_by_name": true,
		"history": true,
		"work_photos": true,
	},
	"VisitHistoryEntry": {
		"status": true, "at": true, "actor_name": true, "actor_role_label": true,
	},
	"WorkPhoto": {
		"kind": true, "url": true, "uploaded_by": true, "uploaded_by_name": true,
		"uploaded_at": true, "visit_log_id": true,
	},
	"VisitList": {"items": true, "total": true, "page": true, "limit": true},
	"PendingRegistrationList": {
		"items": true, "total": true, "pending_count": true, "page": true, "limit": true,
	},
	"PendingRegistrationItem": {
		"vendor_user_id": true, "name": true, "email": true, "phone": true, "nik": true,
		"vendor_name": true, "created_at": true, "status": true,
	},
	"QR":        {"visit_id": true, "qr_code_payload": true},
	"Upload":    {"file_url": true, "file_name": true, "file_size": true, "mime_type": true},
}

// assertSubset fails when obj carries a key outside the named schema.
func assertSubset(t *testing.T, schema string, obj map[string]any) {
	t.Helper()
	allowed := openapiKeys[schema]
	var extra []string
	for k := range obj {
		if !allowed[k] {
			extra = append(extra, k)
		}
	}
	if len(extra) > 0 {
		sort.Strings(extra)
		t.Fatalf("schema %s: invented keys %v", schema, extra)
	}
}

func asObject(t *testing.T, raw json.RawMessage) map[string]any {
	t.Helper()
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil {
		t.Fatalf("not an object: %v: %q", err, string(raw))
	}
	return obj
}

func TestResponseKeysAreSubsetOfOpenapi(t *testing.T) {
	visitSvc := &fakeVisitService{
		listItems: []domain.VisitRequest{cannedVisit()},
		listTotal: 1,
		visitByKey: map[string]domain.VisitRequest{
			"visit-1":        cannedVisit(),
			"VST-0000000001": cannedVisit(),
		},
	}
	visitEngine := gin.New()
	visitEngine.Use(withActor(domain.RoleSuperAdmin, ""))
	vh := handlers.NewVisitHandler(visitSvc)
	visitEngine.GET("/visits", vh.List)
	visitEngine.POST("/visits", vh.Create)
	visitEngine.GET("/visits/:id", vh.Get)
	visitEngine.GET("/visits/:id/qr", vh.QR)
	visitEngine.POST("/visits/:id/work-photos", vh.AttachWorkPhoto)
	visitEngine.PATCH("/visits/:id/visitors/:visitorId", vh.UpdateVisitorContact)

	gateEngine := gin.New()
	gateEngine.Use(withActor(domain.RoleSecurity, "loc-A"))
	gh := handlers.NewGateHandler(&fakeGateService{})
	gateEngine.POST("/visits/:id/checkin", gh.CheckIn)
	gateEngine.POST("/visits/:id/checkout", gh.CheckOut)

	storage := &fakeStorage{result: domain.UploadResult{
		FileURL:  "http://localhost:9000/b/assignment_letters/visit-1/spk.pdf",
		FileName: "spk.pdf", FileSize: 5, MimeType: "application/pdf",
	}}
	uploadEngine := newUploadEngine(storage, 5*1024*1024)

	createPayload := `{
		"location_id": "11111111-1111-1111-1111-111111111111",
		"purpose_ids": ["22222222-2222-2222-2222-222222222222"],
		"start_date": "2026-10-01T09:00:00Z",
		"end_date": "2026-10-01T17:00:00Z",
		"is_nda_accepted": true,
		"assignment_letter_url": "http://localhost:9000/thc-vms-bucket/assignment_letters/visit-1/spk.pdf",
		"visitors": [{"name": "Andi", "id_number": "ID12345678", "phone": "081234567890"}]
	}`

	t.Run("list envelope and items", func(t *testing.T) {
		rec := serve(visitEngine, "GET", "/visits", nil, "")
		mustStatus(t, rec, 200)
		data := asObject(t, mustSuccess(t, rec).Data)
		assertSubset(t, "VisitList", data)
		items, ok := data["items"].([]any)
		if !ok || len(items) != 1 {
			t.Fatalf("items wrong: %v", data["items"])
		}
		detail := items[0].(map[string]any)
		assertSubset(t, "VisitDetail", detail)
		checkVisitDetailNesting(t, detail)
	})

	t.Run("create detail", func(t *testing.T) {
		rec := serveJSON(visitEngine, "POST", "/visits", createPayload)
		mustStatus(t, rec, 201)
		detail := asObject(t, mustSuccess(t, rec).Data)
		assertSubset(t, "VisitDetail", detail)
		checkVisitDetailNesting(t, detail)
	})

	t.Run("get detail", func(t *testing.T) {
		rec := serve(visitEngine, "GET", "/visits/visit-1", nil, "")
		mustStatus(t, rec, 200)
		detail := asObject(t, mustSuccess(t, rec).Data)
		assertSubset(t, "VisitDetail", detail)
		checkVisitDetailNesting(t, detail)
	})

	t.Run("qr payload", func(t *testing.T) {
		rec := serve(visitEngine, "GET", "/visits/visit-1/qr", nil, "")
		mustStatus(t, rec, 200)
		assertSubset(t, "QR", asObject(t, mustSuccess(t, rec).Data))
	})

	t.Run("member contact correction returns one VisitorItem", func(t *testing.T) {
		rec := serveJSON(visitEngine, "PATCH", "/visits/visit-1/visitors/visitor-1", `{"phone": "081234567890"}`)
		mustStatus(t, rec, 200)
		member := asObject(t, mustSuccess(t, rec).Data)
		assertSubset(t, "VisitorItem", member)
	})

	t.Run("work photo attach answers 201 then 200 with one WorkPhoto", func(t *testing.T) {
		body := `{"kind":"before","url":"http://localhost:9000/thc-vms-bucket/work_photos/visit-1/before.jpg"}`
		rec := serveJSON(visitEngine, "POST", "/visits/visit-1/work-photos", body)
		mustStatus(t, rec, 201)
		first := asObject(t, mustSuccess(t, rec).Data)
		assertSubset(t, "WorkPhoto", first)
		if first["kind"] != "before" {
			t.Fatalf("kind = %v, want before", first["kind"])
		}
		visitSvc.attachReplace = true
		rec = serveJSON(visitEngine, "POST", "/visits/visit-1/work-photos", body)
		mustStatus(t, rec, 200)
		assertSubset(t, "WorkPhoto", asObject(t, mustSuccess(t, rec).Data))
	})

	t.Run("detail carries both work photo slots", func(t *testing.T) {
		by := domain.UUID("vendor-1")
		proofVisit := cannedVisit()
		beforeURL := "https://signed.example/work_photos/visit-1/before.jpg?exp=15m0s"
		afterURL := "https://signed.example/work_photos/visit-1/after.jpg?exp=15m0s"
		proofVisit.WorkPhotos = &domain.WorkPhotoSet{
			Before: &domain.WorkPhoto{Kind: domain.WorkPhotoBefore, URL: beforeURL, UploadedBy: &by, UploadedByName: "Dimas Prasetyo"},
			After:  &domain.WorkPhoto{Kind: domain.WorkPhotoAfter, URL: afterURL},
		}
		proofSvc := &fakeVisitService{visitByKey: map[string]domain.VisitRequest{"visit-9": proofVisit}}
		proofEngine := gin.New()
		proofEngine.Use(withActor(domain.RoleSuperAdmin, ""))
		proofEngine.GET("/visits/:id", handlers.NewVisitHandler(proofSvc).Get)

		rec := serve(proofEngine, "GET", "/visits/visit-9", nil, "")
		mustStatus(t, rec, 200)
		detail := asObject(t, mustSuccess(t, rec).Data)
		assertSubset(t, "VisitDetail", detail)
		slots, ok := detail["work_photos"].(map[string]any)
		if !ok || slots == nil {
			t.Fatalf("work_photos missing or not an object: %v", detail["work_photos"])
		}
		for _, slot := range []string{"before", "after"} {
			member, ok := slots[slot].(map[string]any)
			if !ok || member == nil {
				t.Fatalf("work_photos.%s missing: %v", slot, slots)
			}
			assertSubset(t, "WorkPhoto", member)
		}
		if slots["before"].(map[string]any)["url"] != beforeURL {
			t.Fatalf("before url = %v, want the presigned link", slots["before"])
		}
		if _, present := slots["before"].(map[string]any)["kind"]; present {
			t.Fatalf("detail slots must not carry kind: %v", slots["before"])
		}
	})

	t.Run("checkin and checkout are bare success", func(t *testing.T) {
		for _, path := range []string{"/visits/visit-1/checkin", "/visits/visit-1/checkout"} {
			rec := serveJSON(gateEngine, "POST", path, `{}`)
			mustStatus(t, rec, 200)
			env := mustSuccess(t, rec)
			if len(env.Data) != 0 {
				t.Fatalf("%s must be bare success, got data %q", path, string(env.Data))
			}
		}
	})

	t.Run("upload file", func(t *testing.T) {
		body, ctype := multipartUpload(t, "spk.pdf", "application/pdf", []byte("hello"),
			map[string]string{"category": "assignment_letter", "owner_id": "visit-1"})
		rec := serve(uploadEngine, "POST", "/uploads", body, ctype)
		mustStatus(t, rec, 201)
		assertSubset(t, "Upload", asObject(t, mustSuccess(t, rec).Data))
	})
}

// checkVisitDetailNesting asserts the nested objects keep the schema vocabulary.
func checkVisitDetailNesting(t *testing.T, detail map[string]any) {
	t.Helper()
	if loc, ok := detail["location"].(map[string]any); ok && loc != nil {
		assertSubset(t, "Location", loc)
	}
	if purposes, ok := detail["purposes"].([]any); ok {
		for _, p := range purposes {
			assertSubset(t, "Purpose", p.(map[string]any))
		}
	}
	if visitors, ok := detail["visitors"].([]any); ok {
		for _, v := range visitors {
			assertSubset(t, "VisitorItem", v.(map[string]any))
		}
	}
	if history, ok := detail["history"].([]any); ok {
		for _, h := range history {
			assertSubset(t, "VisitHistoryEntry", h.(map[string]any))
		}
	}
	user, ok := detail["vendor_user"].(map[string]any)
	if !ok || user == nil {
		t.Fatalf("vendor_user missing or not an object: %v", detail["vendor_user"])
	}
	assertSubset(t, "User", user)
	if _, ok := user["id"]; !ok {
		t.Fatalf("vendor_user.id missing: %v", user)
	}
	if name, ok := user["name"]; !ok || name == nil {
		t.Fatalf("vendor_user.name missing: %v", user)
	}
	if email, ok := user["email"]; !ok || email == nil {
		t.Fatalf("vendor_user.email missing: %v", user)
	}
}
