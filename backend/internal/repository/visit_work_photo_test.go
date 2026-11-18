package repository

// Atomicity suite for VisitRepository.AttachWorkPhoto / ListWorkPhotos: the
// visiting-only gate plus the upsert write happen in ONE row-locked
// transaction, or nothing at all.

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"thc-vms/backend/internal/domain"
)

const workPhotoTestURL = "http://localhost:9000/thc-vms-bucket/work_photos/visit-1/before.jpg"

// stageVisitingVisit seeds one branch, one vendor account and one visit in
// the executing state, returning the visit id and the vendor user id (the
// attaching actor).
func stageVisitingVisit(t *testing.T, pool *pgxpool.Pool) (domain.UUID, domain.UUID) {
	t.Helper()
	loc := seedLocation(t, pool, "Cabang Bukti", "cabang")
	vendor := seedUser(t, pool, seedUserParams{Name: "Vendor Bukti", Email: "bukti@vendor.test", Role: "vendor", Type: "external"})
	start := time.Now().UTC().Add(24 * time.Hour).Truncate(time.Second)
	visitID := seedVisit(t, pool, seedVisitParams{
		Code: "VST-0000000201", VendorUser: vendor, Location: loc,
		Start: start, End: start.Add(4 * time.Hour), Status: domain.VisitStatusVisiting,
	})
	return visitID, vendor
}

// workPhotoCount counts the proof rows through the repository read under
// test, so the assertions never depend on hand-written SQL.
func workPhotoCount(t *testing.T, repos *visitRepository, visitID domain.UUID) int {
	t.Helper()
	rows, err := repos.ListWorkPhotos(testContext(t), visitID)
	if err != nil {
		t.Fatalf("list work photos: %v", err)
	}
	return len(rows)
}

// TestAttachWorkPhoto_CreatesThenReplacesSingleRow pins the idempotency
// anchor: the first attach creates (true), a re-attach replaces (false), and
// the table never holds more than one row per slot.
func TestAttachWorkPhoto_CreatesThenReplacesSingleRow(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	repos := NewVisitRepository(pool)
	visitID, vendor := stageVisitingVisit(t, pool)

	photo, created, err := repos.AttachWorkPhoto(ctx, visitID, domain.WorkPhotoBefore, workPhotoTestURL, vendor, nil)
	if err != nil {
		t.Fatalf("AttachWorkPhoto: %v", err)
	}
	if !created {
		t.Fatal("created = false, want true for the first attach")
	}
	if photo.Kind != domain.WorkPhotoBefore || photo.URL != workPhotoTestURL {
		t.Fatalf("photo = %+v, want the before proof with the stored URL", photo)
	}
	if photo.UploadedBy == nil || *photo.UploadedBy != vendor {
		t.Fatalf("uploaded_by = %v, want the vendor actor", photo.UploadedBy)
	}
	if photo.UploadedByName != "Vendor Bukti" {
		t.Fatalf("uploaded_by_name = %q, want the joined users.name", photo.UploadedByName)
	}

	replacement := "http://localhost:9000/thc-vms-bucket/work_photos/visit-1/before-v2.jpg"
	photo, created, err = repos.AttachWorkPhoto(ctx, visitID, domain.WorkPhotoBefore, replacement, vendor, nil)
	if err != nil {
		t.Fatalf("re-attach: %v", err)
	}
	if created {
		t.Fatal("created = true, want false for a replacement")
	}
	if photo.URL != replacement {
		t.Fatalf("url = %q, want the replacement URL", photo.URL)
	}
	if n := workPhotoCount(t, repos, visitID); n != 1 {
		t.Fatalf("proof rows = %d, want exactly 1 (replace, not accumulate)", n)
	}
}

// TestAttachWorkPhoto_PreCheckinIsConflict pins the lower half of the gate: a
// visit that has not checked in yet (approved here) refuses the attach with
// 409 and stores nothing.
func TestAttachWorkPhoto_PreCheckinIsConflict(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	repos := NewVisitRepository(pool)

	loc := seedLocation(t, pool, "Cabang Pra", "cabang")
	vendor := seedUser(t, pool, seedUserParams{Name: "Vendor Pra", Email: "pra@vendor.test", Role: "vendor", Type: "external"})
	start := time.Now().UTC().Add(24 * time.Hour).Truncate(time.Second)
	visitID := seedVisit(t, pool, seedVisitParams{
		Code: "VST-0000000202", VendorUser: vendor, Location: loc,
		Start: start, End: start.Add(4 * time.Hour), Status: domain.VisitStatusApproved,
	})

	_, _, err := repos.AttachWorkPhoto(ctx, visitID, domain.WorkPhotoBefore, workPhotoTestURL, vendor, nil)
	if err == nil {
		t.Fatal("pre-check-in attach succeeded, want 409")
	}
	requireErrIs(t, err, domain.ErrConflict, "pre-check-in attach")
	if n := workPhotoCount(t, repos, visitID); n != 0 {
		t.Fatalf("proof rows = %d, want 0: a refused attach must not write", n)
	}
}

// TestAttachWorkPhoto_CheckoutThenAttachCannotSucceedAfterCompletion is the
// ordering proof for the FOR UPDATE gate: a photo attached while visiting
// lands, the visit checks out, and a later attach is refused with 409 — the
// check-out that wins the row lock closes the window for every attach behind
// it, so no photo can land after completion.
func TestAttachWorkPhoto_CheckoutThenAttachCannotSucceedAfterCompletion(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	repos := NewVisitRepository(pool)
	visitID, vendor := stageVisitingVisit(t, pool)

	if _, created, err := repos.AttachWorkPhoto(ctx, visitID, domain.WorkPhotoBefore, workPhotoTestURL, vendor, nil); err != nil || !created {
		t.Fatalf("attach while visiting = (created=%v, err=%v), want (true, nil)", created, err)
	}
	after := "http://localhost:9000/thc-vms-bucket/work_photos/visit-1/after.jpg"
	if _, created, err := repos.AttachWorkPhoto(ctx, visitID, domain.WorkPhotoAfter, after, vendor, nil); err != nil || !created {
		t.Fatalf("attach after while visiting = (created=%v, err=%v), want (true, nil)", created, err)
	}

	adminLoc := seedLocation(t, pool, "Cabang Tutup", "cabang")
	admin := seedUser(t, pool, seedUserParams{Name: "Admin Tutup", Email: "tutup@thc.test", Role: "admin", Location: adminLoc, Type: "internal"})
	if err := repos.UpdateStatus(ctx, visitID, domain.VisitStatusCompleted, admin, "selesai"); err != nil {
		t.Fatalf("checkout: %v", err)
	}

	late := "http://localhost:9000/thc-vms-bucket/work_photos/visit-1/before-late.jpg"
	_, _, err := repos.AttachWorkPhoto(ctx, visitID, domain.WorkPhotoBefore, late, vendor, nil)
	if err == nil {
		t.Fatal("post-check-out attach succeeded, want 409")
	}
	requireErrIs(t, err, domain.ErrConflict, "post-check-out attach")
	var appErr *domain.AppError
	if !errors.As(err, &appErr) || appErr.Status != 409 {
		t.Fatalf("err = %v, want the 409 AppError with the Indonesian message", err)
	}
	if n := workPhotoCount(t, repos, visitID); n != 2 {
		t.Fatalf("proof rows = %d, want still 2 (the late attach stored nothing)", n)
	}
	photos, err := repos.ListWorkPhotos(ctx, visitID)
	if err != nil {
		t.Fatalf("ListWorkPhotos: %v", err)
	}
	for _, photo := range photos {
		if photo.URL == late {
			t.Fatalf("late URL landed in the %+v slot", photo.Kind)
		}
	}
}

// TestAttachWorkPhoto_ConcurrentSameSlotKeepsSingleRow races two attaches to
// the same slot from a start gun: the visit row lock serialises the two
// transactions, the UNIQUE anchor collapses them into one row, and both
// callers succeed (one creates, one replaces).
func TestAttachWorkPhoto_ConcurrentSameSlotKeepsSingleRow(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	repos := NewVisitRepository(pool)
	visitID, vendor := stageVisitingVisit(t, pool)

	var wg sync.WaitGroup
	gun := make(chan struct{})
	errs := make([]error, 2)
	for i := range errs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-gun
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_, _, errs[i] = repos.AttachWorkPhoto(ctx, visitID, domain.WorkPhotoBefore, workPhotoTestURL, vendor, nil)
		}(i)
	}
	close(gun)
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("attach %d: %v, want success (upsert, not a uniqueness clash)", i, err)
		}
	}
	if n := workPhotoCount(t, repos, visitID); n != 1 {
		t.Fatalf("proof rows = %d, want exactly 1 after the race", n)
	}
}

// TestAttachWorkPhoto_UnknownActorRollsBack proves the write is atomic the
// other way: a well-formed but unknown actor violates the uploaded_by foreign
// key AFTER the gate passes, so the rollback must leave zero rows.
func TestAttachWorkPhoto_UnknownActorRollsBack(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	repos := NewVisitRepository(pool)
	visitID, _ := stageVisitingVisit(t, pool)

	ghost := domain.UUID(uuid.NewString())
	_, _, err := repos.AttachWorkPhoto(ctx, visitID, domain.WorkPhotoBefore, workPhotoTestURL, ghost, nil)
	if err == nil {
		t.Fatal("attach with unknown actor succeeded, want FK failure")
	}
	if n := workPhotoCount(t, repos, visitID); n != 0 {
		t.Fatalf("proof rows = %d, want 0 after rollback", n)
	}
}

// TestListWorkPhotos_ReturnsBothProofsWithNames pins the detail-enrichment
// read: both slots come back keyed by kind with the uploader names resolved.
func TestListWorkPhotos_ReturnsBothProofsWithNames(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	repos := NewVisitRepository(pool)
	visitID, vendor := stageVisitingVisit(t, pool)

	after := "http://localhost:9000/thc-vms-bucket/work_photos/visit-1/after.jpg"
	if _, _, err := repos.AttachWorkPhoto(ctx, visitID, domain.WorkPhotoBefore, workPhotoTestURL, vendor, nil); err != nil {
		t.Fatalf("attach before: %v", err)
	}
	if _, _, err := repos.AttachWorkPhoto(ctx, visitID, domain.WorkPhotoAfter, after, vendor, nil); err != nil {
		t.Fatalf("attach after: %v", err)
	}

	photos, err := repos.ListWorkPhotos(ctx, visitID)
	if err != nil {
		t.Fatalf("ListWorkPhotos: %v", err)
	}
	if len(photos) != 2 {
		t.Fatalf("photos = %d, want 2", len(photos))
	}
	byKind := make(map[domain.WorkPhotoKind]domain.WorkPhoto, 2)
	for _, photo := range photos {
		byKind[photo.Kind] = photo
	}
	if byKind[domain.WorkPhotoBefore].URL != workPhotoTestURL {
		t.Fatalf("before url = %q, want the stored URL", byKind[domain.WorkPhotoBefore].URL)
	}
	if byKind[domain.WorkPhotoAfter].URL != after {
		t.Fatalf("after url = %q, want the stored URL", byKind[domain.WorkPhotoAfter].URL)
	}
	for kind, photo := range byKind {
		if photo.UploadedByName != "Vendor Bukti" {
			t.Fatalf("%s uploaded_by_name = %q, want the joined users.name", kind, photo.UploadedByName)
		}
	}
}
