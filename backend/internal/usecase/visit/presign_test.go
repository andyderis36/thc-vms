package visit

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
)

const presignTestBase = "http://localhost:9000/thc-vms-bucket"

// fakeFileStorage is a hand-written fake for domain.IStorageService covering
// the read-path file links: it enforces the same own-bucket prefix rule as
// the MinIO adapter, records the forwarded TTL, and mints deterministic
// signed URLs.
type fakeFileStorage struct {
	lastKey    string
	lastExpiry time.Duration
	signCalls  int
	presignErr error
}

func (f *fakeFileStorage) EnsureBucket(_ context.Context) error { return nil }

func (f *fakeFileStorage) Upload(_ context.Context, _ domain.UploadRequest) (domain.UploadResult, error) {
	return domain.UploadResult{}, domain.ErrStorageRejected
}

func (f *fakeFileStorage) PresignedURL(_ context.Context, objectKey string, expiry time.Duration) (string, error) {
	f.lastKey = objectKey
	f.lastExpiry = expiry
	f.signCalls++
	if f.presignErr != nil {
		return "", f.presignErr
	}
	return "https://signed.example/" + objectKey + "?exp=" + expiry.String(), nil
}

func (f *fakeFileStorage) ObjectKeyFromStoredURL(raw string) (string, error) {
	if !strings.HasPrefix(raw, presignTestBase+"/") {
		return "", domain.ValidationFailure("Tautan berkas di luar bucket.")
	}
	key := strings.TrimPrefix(raw, presignTestBase+"/")
	if i := strings.IndexAny(key, "?#"); i >= 0 {
		key = key[:i]
	}
	if key == "" || strings.Contains(key, "..") {
		return "", domain.ValidationFailure("Tautan berkas tidak valid.")
	}
	return key, nil
}

func seedVisitWithFiles(repo *fakeVisitRepo) domain.VisitRequest {
	letter := presignTestBase + "/assignment_letters/visit-1/spk.pdf"
	ktp := presignTestBase + "/id_cards/visitor-1/ktp.jpg"
	selfie := presignTestBase + "/id_cards/visitor-1/selfie.jpg"
	visit := domain.VisitRequest{
		ID:                  domain.UUID("visit-1"),
		VisitID:             "VST-0000000001",
		PICUserID:           domain.UUID("pic-1"),
		LocationID:          domain.UUID("loc-A"),
		StartDate:           time.Date(2026, time.October, 1, 9, 0, 0, 0, time.UTC),
		EndDate:             time.Date(2026, time.October, 1, 17, 0, 0, 0, time.UTC),
		Status:              domain.VisitStatusApproved,
		AssignmentLetterURL: &letter,
		Visitors: []domain.Visitor{
			{ID: domain.UUID("visitor-1"), Name: "Andi", IDNumber: "ID123", Phone: "0811", IDCardPhotoURL: &ktp, PhotoURL: &selfie},
		},
	}
	seedVisit(repo, visit)
	return visit
}

func textValueOf(s *string) string {
	if s == nil {
		return "<nil>"
	}
	return *s
}

// Given a visit with stored file URLs, when the owner reads it, then the SPK
// and both visitor photos come back as presigned URLs of our bucket (not the
// raw stored addresses) and the forwarded TTL is positive.
func TestGetVisit_PresignsStoredFileURLs(t *testing.T) {
	repo := newFakeVisitRepo(t)
	seedVisitWithFiles(repo)
	files := &fakeFileStorage{}
	svc := newTestService(repo, nil, testNow()).WithFileLinks(files, 15*time.Minute)
	owner := testActor(domain.RoleVendor, "pic-1", "")

	got, err := svc.GetVisit(context.Background(), owner, "visit-1")
	if err != nil {
		t.Fatalf("GetVisit returned error: %v", err)
	}
	if got.AssignmentLetterURL == nil || !strings.HasPrefix(*got.AssignmentLetterURL, "https://signed.example/assignment_letters/visit-1/") {
		t.Fatalf("assignment_letter_url = %q, want presigned bucket URL", textValueOf(got.AssignmentLetterURL))
	}
	if len(got.Visitors) != 1 {
		t.Fatalf("visitors = %d, want 1", len(got.Visitors))
	}
	if got.Visitors[0].IDCardPhotoURL == nil || !strings.HasPrefix(*got.Visitors[0].IDCardPhotoURL, "https://signed.example/id_cards/") {
		t.Fatalf("id_card_photo_url = %q, want presigned bucket URL", textValueOf(got.Visitors[0].IDCardPhotoURL))
	}
	if got.Visitors[0].PhotoURL == nil || !strings.HasPrefix(*got.Visitors[0].PhotoURL, "https://signed.example/id_cards/") {
		t.Fatalf("photo_url = %q, want presigned bucket URL", textValueOf(got.Visitors[0].PhotoURL))
	}
	if files.lastExpiry <= 0 {
		t.Fatalf("forwarded TTL = %s, want positive", files.lastExpiry)
	}
	if files.lastExpiry != 15*time.Minute {
		t.Fatalf("forwarded TTL = %s, want 15m", files.lastExpiry)
	}
}

// Given stored URLs from a foreign origin, when the visit is read, then every
// file link is blanked (never the third-party address).
func TestGetVisit_BlanksForeignFileURLs(t *testing.T) {
	repo := newFakeVisitRepo(t)
	evil := "https://evil.example.com/spk.pdf"
	evilSelfie := "https://cdn.evil.example/x.jpg"
	visit := domain.VisitRequest{
		ID:                  domain.UUID("visit-1"),
		VisitID:             "VST-0000000001",
		PICUserID:           domain.UUID("pic-1"),
		LocationID:          domain.UUID("loc-A"),
		StartDate:           time.Date(2026, time.October, 1, 9, 0, 0, 0, time.UTC),
		EndDate:             time.Date(2026, time.October, 1, 17, 0, 0, 0, time.UTC),
		Status:              domain.VisitStatusApproved,
		AssignmentLetterURL: &evil,
		Visitors:            []domain.Visitor{{ID: domain.UUID("visitor-1"), Name: "Andi", IDNumber: "ID123", Phone: "0811", PhotoURL: &evilSelfie}},
	}
	seedVisit(repo, visit)
	svc := newTestService(repo, nil, testNow()).WithFileLinks(&fakeFileStorage{}, 15*time.Minute)
	owner := testActor(domain.RoleVendor, "pic-1", "")

	got, err := svc.GetVisit(context.Background(), owner, "visit-1")
	if err != nil {
		t.Fatalf("GetVisit returned error: %v", err)
	}
	if got.AssignmentLetterURL != nil {
		t.Fatalf("assignment_letter_url = %q, want blank for foreign URL", *got.AssignmentLetterURL)
	}
	if got.Visitors[0].PhotoURL != nil {
		t.Fatalf("photo_url = %q, want blank for foreign URL", *got.Visitors[0].PhotoURL)
	}
}

// Given actors outside the visit scope, when they read it, then they receive
// an error and therefore no file URL at all (scope is the authz; presign adds
// none).
func TestGetVisit_ScopeRefusesFileURLsWithoutLeak(t *testing.T) {
	repo := newFakeVisitRepo(t)
	seedVisitWithFiles(repo)
	svc := newTestService(repo, nil, testNow()).WithFileLinks(&fakeFileStorage{}, 15*time.Minute)

	adminOther := testActor(domain.RoleAdmin, "admin-9", "loc-B")
	if _, err := svc.GetVisit(context.Background(), adminOther, "visit-1"); err == nil {
		t.Error("cross-branch admin read must be refused, got nil error")
	} else if !errors.Is(err, domain.ErrForbiddenBranch) {
		t.Errorf("cross-branch read error = %v, want forbidden branch", err)
	}

	otherVendor := testActor(domain.RoleVendor, "pic-9", "")
	if _, err := svc.GetVisit(context.Background(), otherVendor, "visit-1"); err == nil {
		t.Error("other vendor read must be refused, got nil error")
	} else if !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("other vendor read error = %v, want not found", err)
	}
}

// Given a scoped list page mixing own-bucket and foreign URLs, when it is
// listed, then own-bucket links are presigned, foreign links are blanked, and
// the forwarded TTL stays positive.
func TestListVisits_PresignsURLsAndBlanksForeign(t *testing.T) {
	repo := newFakeVisitRepo(t)
	own := seedVisitWithFiles(repo)
	evil := "https://evil.example.com/spk.pdf"
	foreign := domain.VisitRequest{
		ID:                  domain.UUID("visit-2"),
		VisitID:             "VST-0000000002",
		PICUserID:           domain.UUID("pic-1"),
		LocationID:          domain.UUID("loc-A"),
		StartDate:           own.StartDate,
		EndDate:             own.EndDate,
		Status:              domain.VisitStatusApproved,
		AssignmentLetterURL: &evil,
	}
	repo.listResult = []domain.VisitRequest{own, foreign}
	repo.listTotal = 2
	files := &fakeFileStorage{}
	svc := newTestService(repo, nil, testNow()).WithFileLinks(files, 15*time.Minute)
	admin := testActor(domain.RoleAdmin, "admin-1", "loc-A")

	items, total, err := svc.ListVisits(context.Background(), admin, ListVisitsInput{Page: 1, Limit: 10})
	if err != nil {
		t.Fatalf("ListVisits returned error: %v", err)
	}
	if total != 2 || len(items) != 2 {
		t.Fatalf("got %d items total %d, want 2/2", len(items), total)
	}
	if items[0].AssignmentLetterURL == nil || !strings.HasPrefix(*items[0].AssignmentLetterURL, "https://signed.example/") {
		t.Fatalf("items[0].assignment_letter_url = %q, want presigned bucket URL", textValueOf(items[0].AssignmentLetterURL))
	}
	if items[1].AssignmentLetterURL != nil {
		t.Fatalf("items[1].assignment_letter_url = %q, want blank for foreign URL", *items[1].AssignmentLetterURL)
	}
	if files.lastExpiry <= 0 {
		t.Fatalf("forwarded TTL = %s, want positive", files.lastExpiry)
	}
}

// Given a non-positive TTL at wiring time, when a visit is read, then the
// default positive TTL is forwarded instead.
func TestWithFileLinks_ClampsNonPositiveTTL(t *testing.T) {
	repo := newFakeVisitRepo(t)
	seedVisitWithFiles(repo)
	files := &fakeFileStorage{}
	svc := newTestService(repo, nil, testNow()).WithFileLinks(files, 0)
	owner := testActor(domain.RoleVendor, "pic-1", "")

	if _, err := svc.GetVisit(context.Background(), owner, "visit-1"); err != nil {
		t.Fatalf("GetVisit returned error: %v", err)
	}
	if files.lastExpiry != 15*time.Minute {
		t.Fatalf("forwarded TTL = %s, want default 15m", files.lastExpiry)
	}
}
