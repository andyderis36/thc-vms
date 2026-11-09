package visit

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
)

// seedVisitingVisit stages one visit owned by vendor-1 in branch loc-A in the
// executing state, so the attach tests start inside the legal window.
func seedVisitingVisit(repo *fakeVisitRepo) domain.VisitRequest {
	visit := seedRequestedVisit(repo)
	visit.Status = domain.VisitStatusVisiting
	seedVisit(repo, visit)
	return visit
}

func workPhotoURL(kind string) string {
	return presignTestBase + "/work_photos/visit-1/" + kind + ".jpg"
}

// Given a visit being executed, when its owning vendor attaches the before
// proof, then the write lands once and the answer reports a creation.
func TestAttachWorkPhoto_OwnerVendorCreatesBeforeProof(t *testing.T) {
	repo := newFakeVisitRepo(t)
	seedVisitingVisit(repo)
	svc := newTestService(repo, nil, testNow())
	owner := testActor(domain.RoleVendor, "vendor-1", "")

	photo, created, err := svc.AttachWorkPhoto(context.Background(), owner, "visit-1", "before", workPhotoURL("before"))
	if err != nil {
		t.Fatalf("AttachWorkPhoto returned error: %v", err)
	}
	if !created {
		t.Fatal("created = false, want true for the first attach")
	}
	if photo.Kind != domain.WorkPhotoBefore {
		t.Fatalf("kind = %q, want before", photo.Kind)
	}
	if photo.URL != workPhotoURL("before") {
		t.Fatalf("url = %q, want the stored URL", photo.URL)
	}
	if photo.UploadedBy == nil || *photo.UploadedBy != domain.UUID("vendor-1") {
		t.Fatalf("uploaded_by = %v, want vendor-1", photo.UploadedBy)
	}
	if repo.writes != 1 {
		t.Fatalf("writes = %d, want exactly 1", repo.writes)
	}
}

// Given an attached before proof, when the same slot is attached again, then
// the row is replaced (no second row accumulates) and the answer reports a
// replacement.
func TestAttachWorkPhoto_ReattachReplacesSingleRow(t *testing.T) {
	repo := newFakeVisitRepo(t)
	seedVisitingVisit(repo)
	svc := newTestService(repo, nil, testNow())
	owner := testActor(domain.RoleVendor, "vendor-1", "")

	first := workPhotoURL("before")
	if _, created, err := svc.AttachWorkPhoto(context.Background(), owner, "visit-1", "before", first); err != nil || !created {
		t.Fatalf("first attach = (created=%v, err=%v), want (true, nil)", created, err)
	}
	second := presignTestBase + "/work_photos/visit-1/before-v2.jpg"
	photo, created, err := svc.AttachWorkPhoto(context.Background(), owner, "visit-1", "before", second)
	if err != nil {
		t.Fatalf("re-attach returned error: %v", err)
	}
	if created {
		t.Fatal("created = true, want false for a replacement")
	}
	if photo.URL != second {
		t.Fatalf("url = %q, want the replacement URL", photo.URL)
	}
	photos, err := repo.ListWorkPhotos(context.Background(), "visit-1")
	if err != nil {
		t.Fatalf("ListWorkPhotos: %v", err)
	}
	if len(photos) != 1 {
		t.Fatalf("proof rows = %d, want exactly 1 (replace, not accumulate)", len(photos))
	}
}

// Given visits outside the execution window, when a proof is attached, then
// the write is refused with a conflict and records zero writes.
func TestAttachWorkPhoto_OutsideVisitingIsConflict(t *testing.T) {
	for name, status := range map[string]domain.VisitStatus{
		"requested":   domain.VisitStatusRequested,
		"approved":    domain.VisitStatusApproved,
		"rescheduled": domain.VisitStatusRescheduled,
		"completed":   domain.VisitStatusCompleted,
		"cancelled":   domain.VisitStatusCancelled,
		"not_visit":   domain.VisitStatusNotVisit,
		"rejected":    domain.VisitStatusRejected,
	} {
		t.Run(name, func(t *testing.T) {
			repo := newFakeVisitRepo(t)
			visit := seedRequestedVisit(repo)
			visit.Status = status
			seedVisit(repo, visit)
			svc := newTestService(repo, nil, testNow())
			owner := testActor(domain.RoleVendor, "vendor-1", "")

			_, _, err := svc.AttachWorkPhoto(context.Background(), owner, "visit-1", "before", workPhotoURL("before"))
			if err == nil {
				t.Fatalf("attach in status %q must be refused, got nil error", status)
			}
			if !errors.Is(err, domain.ErrConflict) {
				t.Fatalf("err = %v, want conflict", err)
			}
			if repo.writes != 0 {
				t.Fatalf("writes = %d, want 0: a refused attach must not write", repo.writes)
			}
		})
	}
}

// Given a visit owned by vendor-1, when a DIFFERENT vendor attaches, then the
// answer is 404-shaped (existence is not disclosed) with zero writes.
func TestAttachWorkPhoto_ForeignVendorIsNotFound(t *testing.T) {
	repo := newFakeVisitRepo(t)
	seedVisitingVisit(repo)
	svc := newTestService(repo, nil, testNow())
	foreign := testActor(domain.RoleVendor, "vendor-9", "")

	_, _, err := svc.AttachWorkPhoto(context.Background(), foreign, "visit-1", "before", workPhotoURL("before"))
	if err == nil {
		t.Fatal("foreign vendor attach must be refused, got nil error")
	}
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("err = %v, want not found", err)
	}
	if repo.writes != 0 {
		t.Fatalf("writes = %d, want 0", repo.writes)
	}
}

// Given a visit in branch loc-A, when an admin of another branch attaches,
// then the answer is 403 with zero writes.
func TestAttachWorkPhoto_OutOfScopeAdminIsForbidden(t *testing.T) {
	repo := newFakeVisitRepo(t)
	seedVisitingVisit(repo)
	svc := newTestService(repo, nil, testNow())
	foreign := testActor(domain.RoleAdmin, "admin-9", "loc-B")

	_, _, err := svc.AttachWorkPhoto(context.Background(), foreign, "visit-1", "before", workPhotoURL("before"))
	if err == nil {
		t.Fatal("out-of-scope admin attach must be refused, got nil error")
	}
	if !errors.Is(err, domain.ErrForbiddenBranch) {
		t.Fatalf("err = %v, want forbidden branch", err)
	}
	if repo.writes != 0 {
		t.Fatalf("writes = %d, want 0", repo.writes)
	}
}

// Given the remaining in-scope roles, when each attaches, then the write
// lands: the branch admin, the branch security and the super_admin may all
// file the proof.
func TestAttachWorkPhoto_InScopeRolesMayAttach(t *testing.T) {
	for name, actor := range map[string]Actor{
		"branch admin":    testActor(domain.RoleAdmin, "admin-1", "loc-A"),
		"branch security": testActor(domain.RoleSecurity, "sec-1", "loc-A"),
		"super_admin":     testActor(domain.RoleSuperAdmin, "super-1", ""),
	} {
		t.Run(name, func(t *testing.T) {
			repo := newFakeVisitRepo(t)
			seedVisitingVisit(repo)
			svc := newTestService(repo, nil, testNow())

			photo, created, err := svc.AttachWorkPhoto(context.Background(), actor, "visit-1", "after", workPhotoURL("after"))
			if err != nil {
				t.Fatalf("AttachWorkPhoto returned error: %v", err)
			}
			if !created {
				t.Fatal("created = false, want true")
			}
			if photo.UploadedBy == nil || *photo.UploadedBy != actor.ID {
				t.Fatalf("uploaded_by = %v, want the acting %s", photo.UploadedBy, name)
			}
		})
	}
}

// Given malformed attach values, when the call runs, then the answer is a
// validation error and zero writes happen: an unknown kind, an empty URL and
// an untrusted URL are all refused before the repository is touched.
func TestAttachWorkPhoto_InvalidKindOrURLIsValidationError(t *testing.T) {
	cases := map[string]struct{ kind, url string }{
		"unknown kind": {kind: "during", url: workPhotoURL("before")},
		"empty kind":   {kind: "  ", url: workPhotoURL("before")},
		"empty url":    {kind: "before", url: "   "},
		// Plain http is refused outside the dev hosts and the configured
		// storage hosts; https (any host) and the dev-host http URLs stay
		// accepted by the shared allowlist.
		"plain http": {kind: "before", url: "http://files.example.com/work_photos/visit-1/before.jpg"},
		"javascript": {kind: "before", url: "javascript:alert(1)"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			repo := newFakeVisitRepo(t)
			seedVisitingVisit(repo)
			svc := newTestService(repo, nil, testNow())
			owner := testActor(domain.RoleVendor, "vendor-1", "")

			_, _, err := svc.AttachWorkPhoto(context.Background(), owner, "visit-1", tc.kind, tc.url)
			if err == nil {
				t.Fatal("invalid attach must be refused, got nil error")
			}
			if !errors.Is(err, domain.ErrValidation) {
				t.Fatalf("err = %v, want validation", err)
			}
			if repo.writes != 0 {
				t.Fatalf("writes = %d, want 0", repo.writes)
			}
		})
	}
}

// Given a visiting visit with both proofs attached, when the single GET runs,
// then the detail carries both slots with presigned URLs (never the raw
// stored addresses); a visit without proofs carries a present-but-empty pair.
func TestGetVisit_EnrichesWorkPhotos(t *testing.T) {
	repo := newFakeVisitRepo(t)
	seedVisitingVisit(repo)
	files := &fakeFileStorage{}
	svc := newTestService(repo, nil, testNow()).WithFileLinks(files, 15*time.Minute)
	owner := testActor(domain.RoleVendor, "vendor-1", "")

	if _, _, err := svc.AttachWorkPhoto(context.Background(), owner, "visit-1", "before", workPhotoURL("before")); err != nil {
		t.Fatalf("attach before: %v", err)
	}
	if _, _, err := svc.AttachWorkPhoto(context.Background(), owner, "visit-1", "after", workPhotoURL("after")); err != nil {
		t.Fatalf("attach after: %v", err)
	}

	got, err := svc.GetVisit(context.Background(), owner, "visit-1")
	if err != nil {
		t.Fatalf("GetVisit returned error: %v", err)
	}
	if got.WorkPhotos == nil || got.WorkPhotos.Before == nil || got.WorkPhotos.After == nil {
		t.Fatalf("work photos = %+v, want both slots filled", got.WorkPhotos)
	}
	for name, photo := range map[string]*domain.WorkPhoto{"before": got.WorkPhotos.Before, "after": got.WorkPhotos.After} {
		if !strings.HasPrefix(photo.URL, "https://signed.example/work_photos/visit-1/") {
			t.Fatalf("%s url = %q, want a presigned bucket URL", name, photo.URL)
		}
	}
}

// Given a visiting visit where the before proof is attached, when the
// work_before file slot resolves, then the stored object streams; the
// cross-branch admin is refused before storage, and an empty slot is 404.
func TestResolveFileStream_WorkProofSlots(t *testing.T) {
	repo := newFakeVisitRepo(t)
	seedVisitingVisit(repo)
	svc := newTestService(repo, nil, testNow())
	owner := testActor(domain.RoleVendor, "vendor-1", "")
	if _, _, err := svc.AttachWorkPhoto(context.Background(), owner, "visit-1", "before", workPhotoURL("before")); err != nil {
		t.Fatalf("attach before: %v", err)
	}

	store := newFakeStreamStorage()
	key := "work_photos/visit-1/before.jpg"
	payload := []byte("bukti-sebelum-pengerjaan")
	store.objects[key] = payload
	store.types[key] = "image/jpeg"
	fileSvc := newFileService(repo, store)

	stream, err := fileSvc.ResolveFileStream(context.Background(), owner, "visit-1", FileKindWorkBefore, "")
	if err != nil {
		t.Fatalf("ResolveFileStream(work_before) error: %v", err)
	}
	defer stream.Content.Close()
	if stream.FileName != "before.jpg" {
		t.Fatalf("FileName = %q, want before.jpg", stream.FileName)
	}
	if store.openCalls != 1 {
		t.Fatalf("storage read = %d, want 1", store.openCalls)
	}

	// The after slot was never attached: 404 without fetching.
	if _, err := fileSvc.ResolveFileStream(context.Background(), owner, "visit-1", FileKindWorkAfter, ""); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("empty work_after must be not found, got %v", err)
	}

	// Same scope predicate as every other slot: a foreign branch never
	// reaches storage.
	foreign := testActor(domain.RoleAdmin, "admin-9", "loc-B")
	if _, err := fileSvc.ResolveFileStream(context.Background(), foreign, "visit-1", FileKindWorkBefore, ""); !errors.Is(err, domain.ErrForbiddenBranch) {
		t.Fatalf("cross-branch read must be forbidden, got %v", err)
	}
	if store.openCalls != 1 {
		t.Fatalf("storage read = %d, want still 1: a refused caller must never fetch", store.openCalls)
	}
}
