package visit

// file_access_test.go pins the RED contract for the planned
// GET /api/v1/visits/:id/file?kind=...&visitor_id=... endpoint at the USECASE
// layer. This file is SPECIFICATION ONLY: it intentionally fails to build
// until the GREEN wave lands the API below.
//
// Planned production API (GREEN wave — NOT implemented by this test file):
//
//	// package visit
//	type FileKind string
//	const (
//	    FileKindAssignmentLetter FileKind = "assignment_letter"
//	    FileKindIDCard           FileKind = "id_card"
//	    FileKindSelfie           FileKind = "selfie"
//	)
//
//	// ObjectStream is the resolved, ready-to-serve file payload for one slot.
//	type ObjectStream struct {
//	    Content     io.ReadCloser
//	    Size        int64
//	    ContentType string
//	    FileName    string
//	    ModTime     time.Time
//	}
//
//	func (s *Service) WithObjectReader(reader domain.ObjectReader) *Service
//	func (s *Service) ResolveFileStream(ctx context.Context, actor Actor, visitID domain.UUID, kind FileKind, visitorID domain.UUID) (ObjectStream, error)
//
//	// package domain
//	type ObjectContent struct {
//	    Content     io.ReadCloser
//	    Size        int64
//	    ContentType string
//	    ModTime     time.Time
//	}
//	type ObjectReader interface {
//	    ObjectKeyFromStoredURL(rawURL string) (string, error)
//	    OpenObject(ctx context.Context, objectKey string) (ObjectContent, error)
//	}
//
// RED expectation: this file fails to build because FileKind,
// FileKindAssignmentLetter/IDCard/Selfie, ObjectStream, (*Service).ResolveFileStream,
// (*Service).WithObjectReader, domain.ObjectContent and domain.ObjectReader do
// not exist yet. Every assertion below IS the contract GREEN implements.
//
// Scope rules mirror (*Service).GetVisit exactly: super_admin passes everywhere;
// admin/security must carry the visit's branch; vendor must own the visit
// (VendorUserID == actor.ID). A refused caller is rejected BEFORE any storage read
// (foreign light: openCalls must stay 0), and a tampered/foreign/empty stored URL
// fails closed as ErrNotFound without fetching.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
)

// fileFixtureLetter is a deterministic SPK payload; the success test hashes it
// so the assertion is "the bytes the store returned", never a fixture-agnostic
// "some bytes came back".
var fileFixtureLetter = []byte("%PDF-1.7\nSPK THC unit-test fixture\n%%EOF\n")

// fakeStreamStorage is the read-path double for ResolveFileStream. It
// implements BOTH the object-key reversal port (domain.IStorageService, used to
// turn a stored URL into a key — same own-bucket prefix rule as the MinIO
// adapter) and the new read port (domain.ObjectReader, used to fetch bytes).
// openCalls counts every fetch so the authz tests can prove a refused caller
// never touches storage.
type fakeStreamStorage struct {
	objects   map[string][]byte
	types     map[string]string
	openCalls int
}

// Compile-time proof the double satisfies both ports GREEN wires.
var (
	_ domain.IStorageService = (*fakeStreamStorage)(nil)
	_ domain.ObjectReader    = (*fakeStreamStorage)(nil)
)

func newFakeStreamStorage() *fakeStreamStorage {
	return &fakeStreamStorage{
		objects: make(map[string][]byte),
		types:   make(map[string]string),
	}
}

func (f *fakeStreamStorage) EnsureBucket(_ context.Context) error { return nil }

func (f *fakeStreamStorage) Upload(_ context.Context, _ domain.UploadRequest) (domain.UploadResult, error) {
	return domain.UploadResult{}, domain.ErrStorageRejected
}

func (f *fakeStreamStorage) PresignedURL(_ context.Context, _ string, _ time.Duration) (string, error) {
	return "", domain.ErrValidation
}

func (f *fakeStreamStorage) DeleteObject(_ context.Context, _ string) error { return nil }

// ObjectKeyFromStoredURL enforces the adapter's own-bucket prefix rule: any URL
// outside presignTestBase, or one carrying an empty/traversal key, is refused
// with ErrValidation so the usecase can fail closed instead of fetching.
func (f *fakeStreamStorage) ObjectKeyFromStoredURL(raw string) (string, error) {
	base := presignTestBase
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || (trimmed != base && !strings.HasPrefix(trimmed, base+"/")) {
		return "", domain.ValidationFailure("Tautan berkas di luar bucket.")
	}
	key := strings.TrimPrefix(strings.TrimPrefix(trimmed, base), "/")
	if key == "" || strings.Contains(key, "..") {
		return "", domain.ValidationFailure("Tautan berkas tidak valid.")
	}
	return key, nil
}

// OpenObject records the fetch and returns the seeded payload, or a 404-shaped
// miss for an unknown key.
func (f *fakeStreamStorage) OpenObject(_ context.Context, objectKey string) (domain.ObjectContent, error) {
	f.openCalls++
	data, ok := f.objects[objectKey]
	if !ok {
		return domain.ObjectContent{}, domain.NotFoundEntity("Berkas")
	}
	return domain.ObjectContent{
		Content:     io.NopCloser(bytes.NewReader(data)),
		Size:        int64(len(data)),
		ContentType: f.types[objectKey],
		ModTime:     testNow(),
	}, nil
}

// newFileService wires the visit usecase with the read port AND the key-reversal
// port so ResolveFileStream can reach storage however it is composed.
func newFileService(repo *fakeVisitRepo, store *fakeStreamStorage) *Service {
	return newTestService(repo, nil, testNow()).
		WithFileLinks(store, 15*time.Minute).
		WithObjectReader(store)
}

// Given a visit in branch loc-A owned by vendor-1, when an admin of a DIFFERENT
// branch asks for its file, then the read is refused with a branch/ownership
// error and storage is never touched.
func TestResolveFileStream_CrossBranchAdminDeniedWithoutStorageRead(t *testing.T) {
	repo := newFakeVisitRepo(t)
	seedVisitWithFiles(repo)
	store := newFakeStreamStorage()
	svc := newFileService(repo, store)
	otherBranch := testActor(domain.RoleAdmin, "admin-9", "loc-B")

	_, err := svc.ResolveFileStream(context.Background(), otherBranch, "visit-1", FileKindAssignmentLetter, "")
	if err == nil {
		t.Fatal("cross-branch admin read must be refused, got nil error")
	}
	if !errors.Is(err, domain.ErrForbiddenBranch) {
		t.Fatalf("err = %v, want forbidden branch", err)
	}
	if store.openCalls != 0 {
		t.Fatalf("storage read = %d, want 0: a refused caller must never reach storage", store.openCalls)
	}
}

// Given a visit owned by vendor-1, when a DIFFERENT vendor asks for its file, then
// the read is 404-shaped (existence is not disclosed) and storage is untouched.
func TestResolveFileStream_OtherVendorDeniedWithoutStorageRead(t *testing.T) {
	repo := newFakeVisitRepo(t)
	seedVisitWithFiles(repo)
	store := newFakeStreamStorage()
	svc := newFileService(repo, store)
	otherVendor := testActor(domain.RoleVendor, "vendor-9", "")

	_, err := svc.ResolveFileStream(context.Background(), otherVendor, "visit-1", FileKindAssignmentLetter, "")
	if err == nil {
		t.Fatal("another vendor's read must be refused, got nil error")
	}
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("err = %v, want not found", err)
	}
	if store.openCalls != 0 {
		t.Fatalf("storage read = %d, want 0: a refused caller must never reach storage", store.openCalls)
	}
}

// Given a stored URL from a foreign origin, a traversal path or a blank value,
// when the slot is requested, then it fails closed with ErrNotFound and no
// fetch is ever attempted (the stored address never becomes a fetch argument).
func TestResolveFileStream_ForeignOrTamperedURLFailsClosed(t *testing.T) {
	cases := map[string]string{
		"foreign host": "https://evil.example.com/assignment_letters/visit-1/spk.pdf",
		"traversal":    presignTestBase + "/assignment_letters/../id_cards/visitor-1/ktp.jpg",
		"blank":        "",
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			repo := newFakeVisitRepo(t)
			visit := seedVisitWithFiles(repo)
			visit.AssignmentLetterURL = &raw
			seedVisit(repo, visit)
			store := newFakeStreamStorage()
			svc := newFileService(repo, store)
			owner := testActor(domain.RoleAdmin, "admin-1", "loc-A")

			_, err := svc.ResolveFileStream(context.Background(), owner, "visit-1", FileKindAssignmentLetter, "")
			if err == nil {
				t.Fatal("foreign/tampered URL must fail closed, got nil error")
			}
			if !errors.Is(err, domain.ErrNotFound) {
				t.Fatalf("err = %v, want not found", err)
			}
			if store.openCalls != 0 {
				t.Fatalf("storage read = %d, want 0: must fail before any fetch", store.openCalls)
			}
		})
	}
}

// Given a visit whose requested slot has no stored URL, when it is requested,
// then it resolves to ErrNotFound without fetching.
func TestResolveFileStream_EmptySlotIsNotFound(t *testing.T) {
	repo := newFakeVisitRepo(t)
	visit := seedVisitWithFiles(repo)
	visit.AssignmentLetterURL = nil
	seedVisit(repo, visit)
	store := newFakeStreamStorage()
	svc := newFileService(repo, store)
	owner := testActor(domain.RoleAdmin, "admin-1", "loc-A")

	_, err := svc.ResolveFileStream(context.Background(), owner, "visit-1", FileKindAssignmentLetter, "")
	if err == nil {
		t.Fatal("empty slot must be not found, got nil error")
	}
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("err = %v, want not found", err)
	}
	if store.openCalls != 0 {
		t.Fatalf("storage read = %d, want 0", store.openCalls)
	}
}

// Given a visit whose visitor slot references an unknown visitor id, when the
// id_card slot is requested, then it is ErrNotFound and nothing is fetched.
func TestResolveFileStream_UnknownVisitorIsNotFoundWithoutFetch(t *testing.T) {
	repo := newFakeVisitRepo(t)
	seedVisitWithFiles(repo)
	store := newFakeStreamStorage()
	svc := newFileService(repo, store)
	owner := testActor(domain.RoleAdmin, "admin-1", "loc-A")

	_, err := svc.ResolveFileStream(context.Background(), owner, "visit-1", FileKindIDCard, "visitor-999")
	if err == nil {
		t.Fatal("unknown visitor must be not found, got nil error")
	}
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("err = %v, want not found", err)
	}
	if store.openCalls != 0 {
		t.Fatalf("storage read = %d, want 0", store.openCalls)
	}
}

// Given an authorized read of the SPK slot, when it resolves, then the stream
// carries the stored bytes (sha256-equal to the fixture) plus size, content
// type and a file name derived from the object key, and exactly one fetch ran.
func TestResolveFileStream_SuccessReturnsBytesMatchingFixtureSHA256(t *testing.T) {
	repo := newFakeVisitRepo(t)
	seedVisitWithFiles(repo)
	store := newFakeStreamStorage()
	key := "assignment_letters/visit-1/spk.pdf"
	store.objects[key] = fileFixtureLetter
	store.types[key] = "application/pdf"
	svc := newFileService(repo, store)
	owner := testActor(domain.RoleAdmin, "admin-1", "loc-A")

	stream, err := svc.ResolveFileStream(context.Background(), owner, "visit-1", FileKindAssignmentLetter, "")
	if err != nil {
		t.Fatalf("ResolveFileStream returned error: %v", err)
	}
	defer stream.Content.Close()

	if store.openCalls != 1 {
		t.Fatalf("storage read = %d, want exactly 1", store.openCalls)
	}
	if stream.ContentType != "application/pdf" {
		t.Fatalf("ContentType = %q, want application/pdf", stream.ContentType)
	}
	if stream.Size != int64(len(fileFixtureLetter)) {
		t.Fatalf("Size = %d, want %d", stream.Size, len(fileFixtureLetter))
	}
	if stream.FileName != "spk.pdf" {
		t.Fatalf("FileName = %q, want spk.pdf (derived from the object key)", stream.FileName)
	}

	got, err := io.ReadAll(stream.Content)
	if err != nil {
		t.Fatalf("reading stream failed: %v", err)
	}
	if sha256.Sum256(got) != sha256.Sum256(fileFixtureLetter) {
		t.Fatalf("stream sha256 = %x, want fixture sha256 %x", sha256.Sum256(got), sha256.Sum256(fileFixtureLetter))
	}
}

// Given the three supported slots seeded with distinct bytes, when each is
// resolved, then the usecase selects the RIGHT stored object (assignment
// letter vs id card vs selfie) and returns its exact bytes.
func TestResolveFileStream_ResolvesEachSlot(t *testing.T) {
	cases := []struct {
		name    string
		kind    FileKind
		visitor domain.UUID
		key     string
	}{
		{"assignment_letter", FileKindAssignmentLetter, "", "assignment_letters/visit-1/spk.pdf"},
		{"id_card", FileKindIDCard, "visitor-1", "id_cards/visitor-1/ktp.jpg"},
		{"selfie", FileKindSelfie, "visitor-1", "id_cards/visitor-1/selfie.jpg"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			repo := newFakeVisitRepo(t)
			seedVisitWithFiles(repo)
			store := newFakeStreamStorage()
			payload := []byte("payload:" + tc.key)
			store.objects[tc.key] = payload
			store.types[tc.key] = "image/jpeg"
			svc := newFileService(repo, store)
			owner := testActor(domain.RoleAdmin, "admin-1", "loc-A")

			stream, err := svc.ResolveFileStream(context.Background(), owner, "visit-1", tc.kind, tc.visitor)
			if err != nil {
				t.Fatalf("ResolveFileStream(%s) error: %v", tc.name, err)
			}
			defer stream.Content.Close()

			got, err := io.ReadAll(stream.Content)
			if err != nil {
				t.Fatalf("reading stream failed: %v", err)
			}
			if sha256.Sum256(got) != sha256.Sum256(payload) {
				t.Fatalf("slot %s served the wrong object: sha256 = %x, want %x", tc.name, sha256.Sum256(got), sha256.Sum256(payload))
			}
			if store.openCalls != 1 {
				t.Fatalf("slot %s storage read = %d, want 1", tc.name, store.openCalls)
			}
		})
	}
}

// Given an authorized read whose object is gone from the bucket, when the slot
// is requested, then it fails closed as a 404 "Berkas tidak tersedia." instead
// of surfacing a 500 for a file that is simply not there.
func TestResolveFileStream_MissingObjectIs404(t *testing.T) {
	repo := newFakeVisitRepo(t)
	seedVisitWithFiles(repo)
	store := newFakeStreamStorage()
	svc := newFileService(repo, store)
	owner := testActor(domain.RoleAdmin, "admin-1", "loc-A")

	_, err := svc.ResolveFileStream(context.Background(), owner, "visit-1", FileKindAssignmentLetter, "")
	if err == nil {
		t.Fatal("a missing object must fail closed, got nil error")
	}
	if store.openCalls != 1 {
		t.Fatalf("storage read = %d, want 1", store.openCalls)
	}
	var appErr *domain.AppError
	if !errors.As(err, &appErr) {
		t.Fatalf("err = %v, want *domain.AppError", err)
	}
	if appErr.Status != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", appErr.Status)
	}
	if appErr.Message != "Berkas tidak tersedia." {
		t.Fatalf("message = %q, want the fail-closed 404 copy", appErr.Message)
	}
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("err = %v, want not found", err)
	}
}
