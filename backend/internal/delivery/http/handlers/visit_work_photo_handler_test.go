package handlers_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/handlers"
	"thc-vms/backend/internal/domain"
)

// newWorkPhotoEngine mounts only the attach route behind the documented
// gin-context identity.
func newWorkPhotoEngine(svc *fakeVisitService, role domain.RoleName, loc string) *gin.Engine {
	engine := gin.New()
	engine.Use(withActor(role, loc))
	h := handlers.NewVisitHandler(svc)
	engine.POST("/visits/:id/work-photos", h.AttachWorkPhoto)
	return engine
}

const workPhotoBody = `{"kind":"before","url":"http://localhost:9000/thc-vms-bucket/work_photos/visit-1/before.jpg"}`

// Given a first attach, when the vendor posts the proof, then the answer is
// 201 with the stored proof body naming the slot.
func TestAttachWorkPhoto_FirstAttachAnswers201(t *testing.T) {
	svc := &fakeVisitService{}
	engine := newWorkPhotoEngine(svc, domain.RoleVendor, "")

	rec := serveJSON(engine, "POST", "/visits/11111111-1111-1111-1111-111111111111/work-photos", workPhotoBody)
	mustStatus(t, rec, http.StatusCreated)
	obj := asObject(t, mustSuccess(t, rec).Data)
	assertSubset(t, "WorkPhoto", obj)
	if obj["kind"] != "before" {
		t.Fatalf("kind = %v, want before", obj["kind"])
	}
	if obj["url"] != "http://localhost:9000/thc-vms-bucket/work_photos/visit-1/before.jpg" {
		t.Fatalf("url = %v, want the stored URL", obj["url"])
	}
	if _, ok := obj["uploaded_at"]; !ok {
		t.Fatalf("uploaded_at missing: %v", obj)
	}
	if svc.lastAttachKind != "before" {
		t.Fatalf("kind = %q, want before", svc.lastAttachKind)
	}
	if svc.lastAttachURL != "http://localhost:9000/thc-vms-bucket/work_photos/visit-1/before.jpg" {
		t.Fatalf("url = %q, want the stored URL", svc.lastAttachURL)
	}
	if svc.lastAttachID != domain.UUID("11111111-1111-1111-1111-111111111111") {
		t.Fatalf("visit id = %q, want the path id", svc.lastAttachID)
	}
}

// Given an already attached slot, when the vendor re-attaches, then the
// answer is 200 with the replaced proof.
func TestAttachWorkPhoto_ReattachAnswers200(t *testing.T) {
	by := domain.UUID("vendor-1")
	name := "Dimas Prasetyo"
	svc := &fakeVisitService{
		attachCreated: false,
		attachPhoto: domain.WorkPhoto{
			Kind:           domain.WorkPhotoBefore,
			URL:            "http://localhost:9000/thc-vms-bucket/work_photos/visit-1/before-v2.jpg",
			UploadedBy:     &by,
			UploadedByName: name,
			UploadedAt:     time.Date(2026, time.October, 2, 9, 0, 0, 0, time.UTC),
		},
	}
	engine := newWorkPhotoEngine(svc, domain.RoleVendor, "")

	rec := serveJSON(engine, "POST", "/visits/11111111-1111-1111-1111-111111111111/work-photos", workPhotoBody)
	mustStatus(t, rec, http.StatusOK)
	env := mustSuccess(t, rec)
	obj := asObject(t, env.Data)
	assertSubset(t, "WorkPhoto", obj)
	if obj["kind"] != "before" {
		t.Fatalf("kind = %v, want before", obj["kind"])
	}
	if obj["uploaded_by_name"] != name {
		t.Fatalf("uploaded_by_name = %v, want %q", obj["uploaded_by_name"], name)
	}
}

// Given malformed bodies, when the attach is posted, then the answer is 400
// and the usecase is never called.
func TestAttachWorkPhoto_MalformedBodyIs400(t *testing.T) {
	for name, body := range map[string]string{
		"missing kind": `{"url":"http://localhost:9000/b/w.jpg"}`,
		"missing url":  `{"kind":"before"}`,
		"blank kind":   `{"kind":"  ","url":"http://localhost:9000/b/w.jpg"}`,
		"blank url":    `{"kind":"before","url":"   "}`,
		"broken json":  `{"kind":`,
	} {
		t.Run(name, func(t *testing.T) {
			svc := &fakeVisitService{}
			engine := newWorkPhotoEngine(svc, domain.RoleVendor, "")

			rec := serveJSON(engine, "POST", "/visits/11111111-1111-1111-1111-111111111111/work-photos", body)
			mustStatus(t, rec, http.StatusBadRequest)
			env := decodeEnvelope(t, rec)
			if env.Success || env.Error == nil || env.Error.Code != "VALIDATION_ERROR" {
				t.Fatalf("want the VALIDATION_ERROR envelope, got %q", rec.Body.String())
			}
			if svc.lastAttachKind != "" || svc.lastAttachURL != "" {
				t.Fatal("usecase must not run on a malformed body")
			}
		})
	}
}

// Given usecase refusals, when the attach is posted, then each projects onto
// its HTTP status through the shared envelope: 404 hides a foreign visit,
// 403 marks the branch boundary, 409 marks the closed window, 422 marks a
// bad kind or URL.
func TestAttachWorkPhoto_UsecaseErrorsProjectOntoStatuses(t *testing.T) {
	for name, tc := range map[string]struct {
		err  error
		want int
		code string
	}{
		"foreign visit":   {err: domain.NotFoundEntity("Kunjungan"), want: http.StatusNotFound, code: "NOT_FOUND"},
		"out of scope":    {err: domain.ForbiddenBranch(), want: http.StatusForbidden, code: "FORBIDDEN_BRANCH"},
		"closed window":   {err: domain.Conflict("Bukti pengerjaan hanya dapat dilampirkan saat kunjungan sedang berlangsung."), want: http.StatusConflict, code: "CONFLICT"},
		"bad kind or url": {err: domain.ValidationFailure("Jenis bukti pengerjaan tidak dikenal."), want: http.StatusUnprocessableEntity, code: "VALIDATION_ERROR"},
	} {
		t.Run(name, func(t *testing.T) {
			svc := &fakeVisitService{attachErr: tc.err}
			engine := newWorkPhotoEngine(svc, domain.RoleVendor, "")

			rec := serveJSON(engine, "POST", "/visits/11111111-1111-1111-1111-111111111111/work-photos", workPhotoBody)
			mustStatus(t, rec, tc.want)
			env := decodeEnvelope(t, rec)
			if env.Success || env.Error == nil || env.Error.Code != tc.code {
				t.Fatalf("want code %q, got %q", tc.code, rec.Body.String())
			}
		})
	}
}
