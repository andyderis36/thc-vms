package storage

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"

	"thc-vms/backend/internal/config"
	"thc-vms/backend/internal/domain"
)

// MinIOAdapter is the MinIO/S3 implementation of domain.IStorageService. It is
// the only place in the backend that talks to object storage, so the upload
// policy, the object-key layout and the public URL shape are decided exactly
// once. A production S3 or R2 deployment swaps this adapter for another
// implementation of the same port without touching a usecase.
type MinIOAdapter struct {
	client        *minio.Client
	bucket        string
	region        string
	publicBaseURL string
	policy        policy
}

// compile-time proof that the adapter satisfies the ports it is written for.
var (
	_ domain.IStorageService = (*MinIOAdapter)(nil)
	_ domain.ObjectReader    = (*MinIOAdapter)(nil)
)

// NewMinIOAdapter builds the adapter from configuration. Endpoint, credentials
// and bucket name are mandatory: a half-configured storage driver must fail at
// startup rather than at the first upload.
func NewMinIOAdapter(cfg *config.Config) (*MinIOAdapter, error) {
	if cfg == nil {
		return nil, errors.New("storage: config is required")
	}
	storage := cfg.Storage
	if storage.Endpoint == "" {
		return nil, errors.New("storage: S3_ENDPOINT is required")
	}
	if storage.Bucket == "" {
		return nil, errors.New("storage: S3_BUCKET_NAME is required")
	}
	client, err := minio.New(storage.Endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(storage.AccessKeyID, storage.SecretAccessKey, ""),
		Secure: storage.UseSSL,
		Region: storage.Region,
	})
	if err != nil {
		return nil, fmt.Errorf("storage: create minio client for %q: %w", storage.Endpoint, err)
	}
	return &MinIOAdapter{
		client:        client,
		bucket:        storage.Bucket,
		region:        storage.Region,
		publicBaseURL: strings.TrimRight(storage.PublicBaseURL, "/"),
		policy:        newPolicy(cfg.Upload),
	}, nil
}

// EnsureBucket creates the bucket when it is absent and is a no-op when it
// already exists. The compose stack cannot seed the bucket on every developer
// machine, so the application owns that step: calling it on each boot makes a
// fresh environment self-healing without a separate init container.
func (a *MinIOAdapter) EnsureBucket(ctx context.Context) error {
	exists, err := a.client.BucketExists(ctx, a.bucket)
	if err != nil {
		return fmt.Errorf("storage: probe bucket %q: %w", a.bucket, err)
	}
	if exists {
		return nil
	}
	if err := a.client.MakeBucket(ctx, a.bucket, minio.MakeBucketOptions{Region: a.region}); err != nil {
		// A concurrent boot may have won the race; that is success, not failure.
		if isAlreadyOwned(err) {
			return nil
		}
		return fmt.Errorf("storage: create bucket %q: %w", a.bucket, err)
	}
	return nil
}

// isAlreadyOwned reports whether the create failed only because the bucket is
// there, which happens when two instances boot at once.
func isAlreadyOwned(err error) bool {
	response := minio.ToErrorResponse(err)
	return response.Code == "BucketAlreadyOwnedByYou" || response.Code == "BucketAlreadyExists"
}

// objectMissing honours the ObjectReader contract ("a missing key is
// ErrNotFound"): without this translation a dangling row becomes a 500.
func objectMissing(err error) bool {
	response := minio.ToErrorResponse(err)
	return response.Code == "NoSuchKey" || response.StatusCode == http.StatusNotFound
}

// Upload stores one file and returns its public URL.
//
// The order is deliberate and is the security-relevant part: the caller's hint
// is split, the upload policy is applied, the bytes are prepared (compressed
// and re-checked against the stored ceiling), and only then is the object key
// built from the adapter's own layout. A refused upload has therefore spent no
// network round trip and no bucket I/O, a caller can never talk the adapter
// into a directory of its own choosing, and nothing is persisted unless the
// final bytes fit the stored ceiling.
func (a *MinIOAdapter) Upload(ctx context.Context, in domain.UploadRequest) (domain.UploadResult, error) {
	category, ownerID, err := splitObjectKeyHint(in.ObjectKey)
	if err != nil {
		return domain.UploadResult{}, err
	}
	if err := validateUpload(a.policy, in); err != nil {
		return domain.UploadResult{}, err
	}
	content, mimeType, err := prepareStoredContent(in, a.policy)
	if err != nil {
		return domain.UploadResult{}, err
	}
	objectKey, err := buildObjectKey(category, ownerID, in.FileName)
	if err != nil {
		return domain.UploadResult{}, err
	}

	if _, err := a.client.PutObject(ctx, a.bucket, objectKey, bytes.NewReader(content), int64(len(content)), minio.PutObjectOptions{
		ContentType: mimeType,
	}); err != nil {
		return domain.UploadResult{}, fmt.Errorf("storage: put %q: %w", objectKey, err)
	}

	return domain.UploadResult{
		FileURL:  a.publicObjectURL(objectKey),
		FileName: sanitiseStoredName(in.FileName),
		FileSize: int64(len(content)),
		MimeType: mimeType,
	}, nil
}

// PresignedURL mints a time-boxed direct link to a stored object. A
// non-positive expiry is refused: minio would otherwise sign a link that is
// already invalid, and a caller would be handed a URL that can never work.
func (a *MinIOAdapter) PresignedURL(ctx context.Context, objectKey string, expiry time.Duration) (string, error) {
	if expiry <= 0 {
		return "", fmt.Errorf("storage: presigned expiry must be positive, got %s: %w", expiry, domain.ErrValidation)
	}
	presigned, err := a.client.PresignedGetObject(ctx, a.bucket, objectKey, expiry, nil)
	if err != nil {
		return "", fmt.Errorf("storage: presign %q: %w", objectKey, err)
	}
	return presigned.String(), nil
}

// OpenObject streams one stored object for inline serving behind the scoped
// GET /visits/:id/file endpoint. The body is the live S3 stream, never a
// buffered copy: GetObject only dials, Stat fires the single HEAD that
// resolves size, content type and mtime (and surfaces a missing key), and the
// caller streams and closes the body. A missing key surfaces the S3 NoSuchKey
// error, which the usecase maps onto its 404.
func (a *MinIOAdapter) OpenObject(ctx context.Context, objectKey string) (domain.ObjectContent, error) {
	if strings.TrimSpace(objectKey) == "" {
		return domain.ObjectContent{}, fmt.Errorf("storage: object key kosong: %w", domain.ErrValidation)
	}
	obj, err := a.client.GetObject(ctx, a.bucket, objectKey, minio.GetObjectOptions{})
	if err != nil {
		return domain.ObjectContent{}, fmt.Errorf("storage: open %q: %w", objectKey, err)
	}
	info, err := obj.Stat()
	if err != nil {
		_ = obj.Close()
		if objectMissing(err) {
			return domain.ObjectContent{}, fmt.Errorf("storage: stat %q: %w", objectKey, domain.ErrNotFound)
		}
		return domain.ObjectContent{}, fmt.Errorf("storage: stat %q: %w", objectKey, err)
	}
	return domain.ObjectContent{
		Content:     obj,
		Size:        info.Size,
		ContentType: info.ContentType,
		ModTime:     info.LastModified,
	}, nil
}

// DeleteObject removes one stored object by its bucket key.
func (a *MinIOAdapter) DeleteObject(ctx context.Context, key string) error {
	if err := a.client.RemoveObject(ctx, a.bucket, key, minio.RemoveObjectOptions{}); err != nil {
		return fmt.Errorf("storage: delete %q: %w", key, err)
	}
	return nil
}

// ListObjects returns every object under prefix, recursively, with its
// last-modified time. The prefix is mandatory: an empty one would enumerate
// the whole bucket, which no caller needs and no caller shall get (the same
// fail-closed stance OpenObject takes on an empty key). A driver-side
// listing error aborts with no partial result — a consumer that cannot see
// the whole prefix must not act on a fragment of it (the reaper would
// otherwise delete the visible orphans and miss the rest of the prefix,
// pretending the pass was complete).
func (a *MinIOAdapter) ListObjects(ctx context.Context, prefix string) ([]domain.ObjectInfo, error) {
	if prefix == "" {
		return nil, fmt.Errorf("storage: list requires a prefix: %w", domain.ErrValidation)
	}
	objectCh := a.client.ListObjects(ctx, a.bucket, minio.ListObjectsOptions{
		Prefix:    prefix,
		Recursive: true,
	})
	var objects []domain.ObjectInfo
	for obj := range objectCh {
		if obj.Err != nil {
			return nil, fmt.Errorf("storage: list %q: %w", prefix, obj.Err)
		}
		objects = append(objects, domain.ObjectInfo{Key: obj.Key, ModTime: obj.LastModified})
	}
	return objects, nil
}

// RemoveObjects deletes every key in one batched pass. minio-go groups the
// feed into S3 multi-object-delete requests of at most 1000 keys per API
// call itself; the reaper additionally chunks its calls at 1000 so the
// discipline is visible and testable at the port, not just inside the SDK.
// An empty batch is a no-op. Any per-key failure is joined into one error:
// the caller counts the whole batch as failed and never as deleted.
func (a *MinIOAdapter) RemoveObjects(ctx context.Context, keys []string) error {
	if len(keys) == 0 {
		return nil
	}
	objectsCh := make(chan minio.ObjectInfo, len(keys))
	for _, key := range keys {
		objectsCh <- minio.ObjectInfo{Key: key}
	}
	close(objectsCh)
	var failures []error
	for failure := range a.client.RemoveObjects(ctx, a.bucket, objectsCh, minio.RemoveObjectsOptions{}) {
		failures = append(failures, fmt.Errorf("remove %q: %w", failure.ObjectName, failure.Err))
	}
	if len(failures) > 0 {
		return fmt.Errorf("storage: remove %d of %d objects: %w", len(failures), len(keys), errors.Join(failures...))
	}
	return nil
}

// publicObjectURL builds the absolute URL a browser fetches. It is composed from
// S3_PUBLIC_BASE_URL rather than the client's internal endpoint, so the value
// stored in the database stays correct when the deployment moves behind a proxy
// or a CDN.
func (a *MinIOAdapter) publicObjectURL(objectKey string) string {
	if a.publicBaseURL == "" {
		return objectKey
	}
	return a.publicBaseURL + "/" + objectKey
}

// sanitiseStoredName echoes back the name as it was actually stored, so the
// response never claims a path the bucket does not hold.
func sanitiseStoredName(fileName string) string {
	safe, err := sanitiseFileName(fileName)
	if err != nil {
		return fileName
	}
	return safe
}
