package domain

import (
	"context"
	"io"
	"time"
)

// Clock is the time source usecases depend on instead of calling time.Now
// directly, so scheduling rules (the check-in tolerance window, the
// end_date + 24h auto-complete) stay unit-testable with a frozen clock.
type Clock interface {
	Now() time.Time
}

// SystemClock is the production Clock backed by the wall clock.
type SystemClock struct{}

// Now returns the current wall-clock time.
func (SystemClock) Now() time.Time {
	return time.Now()
}

// UploadRequest is the single input to IStorageService.Upload. Size and
// ContentType travel with the bytes so the adapter can enforce the
// MAX_UPLOAD_SIZE_MB and ALLOWED_MIME_TYPES policy before touching the wire.
type UploadRequest struct {
	ObjectKey   string
	FileName    string
	ContentType string
	Size        int64
	Content     io.Reader
}

// UploadResult mirrors the data object of the openapi UploadFileResponse.
type UploadResult struct {
	FileURL  string
	FileName string
	FileSize int64
	MimeType string
}

// IStorageService is the SOLID dependency-inversion port every object-storage
// driver implements (MinIO locally, S3/R2 in production). Its Upload refuses
// oversized or mistyped files with ErrStorageRejected; the concrete limits
// come from config, never from drum code.
type IStorageService interface {
	// EnsureBucket creates the bucket when absent so the first boot never
	// fails on a fresh MinIO.
	EnsureBucket(ctx context.Context) error
	// Upload stores one file under objectKey and returns its public URL.
	Upload(ctx context.Context, in UploadRequest) (UploadResult, error)
	// PresignedURL mints a time-boxed direct link to one stored object.
	PresignedURL(ctx context.Context, objectKey string, expiry time.Duration) (string, error)
}

// UserRepository is the port the PostgreSQL adapter implements for accounts.
type UserRepository interface {
	FindByEmail(ctx context.Context, email string) (User, error)
	FindByID(ctx context.Context, id UUID) (User, error)
	Create(ctx context.Context, user User) (User, error)
	UpdateStatus(ctx context.Context, id UUID, status UserStatus) error
	// UpdateLastLogin stamps a successful authentication. It is a write on the
	// hot login path, so it must never be able to fail the login itself: the
	// caller logs and continues when it errors.
	UpdateLastLogin(ctx context.Context, id UUID, at time.Time) error
	// ListSecurity returns the gate staff accounts for one branch. A nil
	// locationID means "every branch" and is reserved for super_admin; admin and
	// security callers must always pass their own location so the adapter can
	// emit the branch-equality predicate (PRD L110).
	ListSecurity(ctx context.Context, locationID *UUID) ([]User, error)
}

// VisitFilter scopes a visit listing to the caller's branch and role, which
// is how the backend enforces multi-branch isolation: admins and security
// pass their own location_id, super_admin passes nil, and PIC passes its own
// user id. Page starts at 1; Limit caps the page size.
type VisitFilter struct {
	LocationID *UUID
	PICUserID  *UUID
	Status     *VisitStatus
	From       *time.Time
	To         *time.Time
	Page       int
	Limit      int
}

// VisitRepository is the port the PostgreSQL adapter implements for the visit
// lifecycle. Create persists the request together with its visitors and
// purpose links in one transaction.
//
// Every status-changing method writes the new status AND its status_history row
// in ONE transaction, because the PRD requires the lifecycle to be recorded
// atomically: a status without its history row (or the reverse) is a data-integrity
// break that no later repair can distinguish from a legitimate write. changedBy
// is the acting user; pass the empty UUID for automatic transitions, which the
// adapter must persist as SQL NULL rather than the uuid zero value.
type VisitRepository interface {
	Create(ctx context.Context, visit VisitRequest, visitors []Visitor, purposeIDs []UUID) (VisitRequest, error)
	FindByID(ctx context.Context, id UUID) (VisitRequest, error)
	FindByVisitCode(ctx context.Context, code string) (VisitRequest, error)
	List(ctx context.Context, filter VisitFilter) (visits []VisitRequest, total int64, err error)
	// UpdateStatus moves one visit to status and appends the history row in the
	// same transaction. It must lock the visit row first (SELECT ... FOR UPDATE)
	// so two concurrent approvals cannot both succeed, and it must translate
	// domain.ErrInvalidTransition-free callers' expectations: a status value
	// outside the eight-value vocabulary returns domain.ErrUnknownVisitStatus.
	UpdateStatus(ctx context.Context, id UUID, status VisitStatus, changedBy UUID, notes string) error
	// Reschedule writes the new window, flips the status to rescheduled and
	// appends the history row atomically; reason is stored as the history note.
	Reschedule(ctx context.Context, id UUID, start, end time.Time, changedBy UUID, reason string) error
}

// VisitAutoRuleRepository is the read side of the background worker: each method
// returns the visits a single automatic rule currently matches, given the
// rule's threshold instant. The worker then re-asserts the match and applies the
// transition through VisitRepository.UpdateStatus so the history row is written
// by the same code path as a manual transition.
//
// The three rules come from the PRD state machine:
//
//	R1 status=requested and created_at  < before            -> cancelled  (7 days)
//	R2 status=approved  and end_date    < before and no check-in -> not_visit
//	R3 status=visiting  and end_date    < before            -> completed  (end_date + 24h)
type VisitAutoRuleRepository interface {
	FindStaleRequested(ctx context.Context, before time.Time) ([]VisitRequest, error)
	FindNoShowApproved(ctx context.Context, before time.Time) ([]VisitRequest, error)
	FindOverstayedVisiting(ctx context.Context, before time.Time) ([]VisitRequest, error)
}

// MasterDataRepository is the port serving the location and purpose
// catalogues both the admin console and the visit form consume.
type MasterDataRepository interface {
	ListLocations(ctx context.Context, onlyActive bool) ([]Location, error)
	FindLocationByID(ctx context.Context, id UUID) (Location, error)
	ListPurposes(ctx context.Context, onlyActive bool) ([]Purpose, error)
}

// CheckInOutRepository is the port persisting gate records. The schema keeps
// one check-in and one check-out per visit, so recording a second one for the
// same visit surfaces ErrConflict.
type CheckInOutRepository interface {
	RecordCheckIn(ctx context.Context, checkIn CheckIn) (CheckIn, error)
	RecordCheckOut(ctx context.Context, checkOut CheckOut) (CheckOut, error)
	FindCheckInByVisit(ctx context.Context, visitID UUID) (CheckIn, error)
	FindCheckOutByVisit(ctx context.Context, visitID UUID) (CheckOut, error)
}
