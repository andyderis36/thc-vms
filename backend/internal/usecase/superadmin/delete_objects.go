package superadmin

import (
	"context"
	"log/slog"
	"strings"

	"thc-vms/backend/internal/domain"
)

// CollectUserStorageKeys returns the bucket keys one account row still
// references — currently only users.avatar_url — collected BEFORE DELETE
// /users/:id removes the row. The reversal runs through the storage port
// (never a raw URL split here): a blank URL is skipped silently, and a URL
// that refuses to reverse (foreign host, unknown directory, traversal) is
// logged and skipped, because only our own bucket keys are deletable and a
// refusal means there is nothing of ours to remove. A nil storage port
// collects nothing, so unwired delete paths stay DB-only.
func CollectUserStorageKeys(storage domain.IStorageService, target domain.ManagedUser) []string {
	if storage == nil {
		return nil
	}
	return collectStoredKeys(storage, target.User.AvatarURL)
}

// CollectVisitStorageKeys returns the bucket keys a visit purge would orphan:
// the assignment letter, every visitor's KTP and selfie, the check-in photo
// (nil checkIn means the visit never checked in), plus any extra stored URLs
// the caller hands over — the purge caller passes the visit's work photo
// URLs because the visit row itself carries no work-photo members. The child
// rows go away with the visit through ON DELETE CASCADE, so every key must
// be read while the rows are still there — row-first, object-second. The
// reversal rule matches CollectUserStorageKeys: blanks are skipped silently,
// unresolvable URLs are logged and skipped.
func CollectVisitStorageKeys(storage domain.IStorageService, visit domain.VisitRequest, checkIn *domain.CheckIn, extraURLs ...string) []string {
	if storage == nil {
		return nil
	}
	raws := make([]string, 0, 2+2*len(visit.Visitors)+len(extraURLs))
	if visit.AssignmentLetterURL != nil {
		raws = append(raws, *visit.AssignmentLetterURL)
	}
	for _, visitor := range visit.Visitors {
		if visitor.IDCardPhotoURL != nil {
			raws = append(raws, *visitor.IDCardPhotoURL)
		}
		if visitor.PhotoURL != nil {
			raws = append(raws, *visitor.PhotoURL)
		}
	}
	if checkIn != nil && checkIn.PhotoURL != nil {
		raws = append(raws, *checkIn.PhotoURL)
	}
	raws = append(raws, extraURLs...)
	return collectStoredKeys(storage, raws...)
}

// collectStoredKeys reverses each stored URL to its bucket key through the
// port. A non-blank URL that will not reverse is logged and dropped: the
// reversal only ever yields OUR keys, so a refusal means the URL points
// outside our bucket and there is nothing for us to delete.
func collectStoredKeys(storage domain.IStorageService, raws ...string) []string {
	keys := make([]string, 0, len(raws))
	for _, raw := range raws {
		if strings.TrimSpace(raw) == "" {
			continue
		}
		key, err := storage.ObjectKeyFromStoredURL(raw)
		if err != nil {
			slog.Warn("superadmin: stored URL skipped for storage cleanup", "url", raw, "error", err)
			continue
		}
		if key == "" {
			continue
		}
		keys = append(keys, key)
	}
	return keys
}

// DeleteRowThenObjects is the collect-then-delete ordering guard for the
// super_admin purge paths: deleteRow (the DB delete, audit included) runs
// FIRST and owns the commit; only a successful commit triggers ONE
// best-effort batch over the collected object keys. A row failure returns
// its error before any storage call, so a failed delete never touches
// objects — they stay referenced and reaper-recoverable, never dangling the
// other way. A storage failure is logged per key and swallowed: the
// committed delete still answers success, and the leftover object is an
// orphan a later sweep can retry. Keys are deduped and blanks dropped
// inside the batch, so the same URL stored on two rows is deleted once.
func DeleteRowThenObjects(ctx context.Context, storage domain.IStorageService, keys []string, deleteRow func() error) error {
	if err := deleteRow(); err != nil {
		return err
	}
	deleteCollectedObjects(ctx, storage, keys)
	return nil
}

// deleteCollectedObjects best-effort removes every distinct non-blank key:
// one DeleteObject per key, failures logged (never returned), and a summary
// count logged so the cleanup volume per purge is visible in the logs.
func deleteCollectedObjects(ctx context.Context, storage domain.IStorageService, keys []string) {
	if storage == nil || len(keys) == 0 {
		return
	}
	unique := dedupeKeys(keys)
	if len(unique) == 0 {
		return
	}
	failed := 0
	for _, key := range unique {
		if err := storage.DeleteObject(ctx, key); err != nil {
			failed++
			slog.Warn("superadmin: delete stored object failed", "key", key, "error", err)
		}
	}
	slog.Info("superadmin: storage cleanup after delete", "count", len(unique), "failed", failed)
}

// dedupeKeys drops blanks and repeats while keeping first-seen order, so a
// purge's cleanup log stays deterministic.
func dedupeKeys(keys []string) []string {
	seen := make(map[string]struct{}, len(keys))
	unique := make([]string, 0, len(keys))
	for _, raw := range keys {
		key := strings.TrimSpace(raw)
		if key == "" {
			continue
		}
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		unique = append(unique, key)
	}
	return unique
}
