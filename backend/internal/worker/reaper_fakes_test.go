package worker_test

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"thc-vms/backend/internal/domain"
)

// reaperFakeBucketBase is the stored-URL shape the fake reverses, mimicking
// the adapter's own-bucket segment rule: URLs outside it are refused.
const reaperFakeBucketBase = "http://minio.local/thc-vms-bucket/"

type fakeReaperStore struct {
	mu              sync.Mutex
	objectsByPrefix map[string][]domain.ObjectInfo
	listErrs        map[string]error
	listedPrefixes  []string
	removeBatches   [][]string
	removeErr       error
}

func newFakeReaperStore() *fakeReaperStore {
	return &fakeReaperStore{
		objectsByPrefix: make(map[string][]domain.ObjectInfo),
		listErrs:        make(map[string]error),
	}
}

// add seeds objects under one prefix verbatim — including out-of-scope keys,
// so tests can prove the reaper enforces the pending/ boundary itself even
// when the lister misbehaves.
func (f *fakeReaperStore) add(prefix string, objects ...domain.ObjectInfo) {
	f.objectsByPrefix[prefix] = append(f.objectsByPrefix[prefix], objects...)
}

func (f *fakeReaperStore) ObjectKeyFromStoredURL(rawURL string) (string, error) {
	if !strings.HasPrefix(rawURL, reaperFakeBucketBase) {
		return "", fmt.Errorf("fakeReaperStore: foreign url %q: %w", rawURL, domain.ErrValidation)
	}
	return strings.TrimPrefix(rawURL, reaperFakeBucketBase), nil
}

func (f *fakeReaperStore) ListObjects(_ context.Context, prefix string) ([]domain.ObjectInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.listedPrefixes = append(f.listedPrefixes, prefix)
	if err, ok := f.listErrs[prefix]; ok {
		return nil, err
	}
	return append([]domain.ObjectInfo(nil), f.objectsByPrefix[prefix]...), nil
}

func (f *fakeReaperStore) RemoveObjects(_ context.Context, keys []string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.removeErr != nil {
		return f.removeErr
	}
	f.removeBatches = append(f.removeBatches, append([]string(nil), keys...))
	return nil
}

func (f *fakeReaperStore) prefixes() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.listedPrefixes...)
}

func (f *fakeReaperStore) batches() [][]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([][]string, len(f.removeBatches))
	for i, b := range f.removeBatches {
		out[i] = append([]string(nil), b...)
	}
	return out
}

func (f *fakeReaperStore) deletedKeys() []string {
	var out []string
	for _, batch := range f.batches() {
		out = append(out, batch...)
	}
	return out
}

type fakeReaperRepo struct {
	urls     []string
	listErr  error
	lockErr  error
	lockHeld bool
	acquired int
	released int
}

func (f *fakeReaperRepo) ListReferencedURLs(context.Context) ([]string, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	return append([]string(nil), f.urls...), nil
}

func (f *fakeReaperRepo) TryLock(context.Context) (func() error, bool, error) {
	if f.lockErr != nil {
		return nil, false, f.lockErr
	}
	if f.lockHeld {
		return nil, false, nil
	}
	f.acquired++
	return func() error {
		f.released++
		return nil
	}, true, nil
}
