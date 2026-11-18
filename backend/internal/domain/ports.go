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
	// ObjectKeyFromStoredURL reverses a stored absolute file URL back to its
	// bucket object key. The host is a deployment detail and is ignored: what
	// binds a URL to our bucket is the bucket name appearing as a full path
	// segment, so a URL stored under an earlier host keeps resolving and the
	// key is always read from OUR OWN bucket (bucket privat: FE tidak boleh
	// memakai URL mentah dari DB, backend menukar tiap URL menjadi presigned
	// saat serialisasi). An empty URL, a URL that does not expose our bucket
	// segment, or a traversal-carrying URL is refused with ErrValidation so
	// callers blank it instead of leaking a third-party address. Parsing lives
	// on the adapter (SRP): only the storage owner knows the bucket name and
	// the key layout; usecases never split URLs themselves.
	ObjectKeyFromStoredURL(rawURL string) (string, error)
	// DeleteObject removes one stored object by its bucket key.
	DeleteObject(ctx context.Context, key string) error
}

// ObjectContent is the streamed payload of one stored object: the open body
// plus the headers an HTTP file response needs. The body streams straight
// from the bucket (never buffered whole: the 5 MB upload ceiling does not
// make whole-file reads free); the caller owns closing Content.
type ObjectContent struct {
	Content     io.ReadCloser
	Size        int64
	ContentType string
	ModTime     time.Time
}

// ObjectInfo is one object as a storage driver lists it: its full key and
// the last-modified instant a consumer measures age against (the reaper's
// grace window). It is the shared element shape for prefix listing; the
// ports that consume it live with their consumer (the worker names its own
// narrow seam), so domain carries only the data, never the listing policy.
type ObjectInfo struct {
	Key     string
	ModTime time.Time
}

// ObjectReader is the read half of object storage behind the scoped
// GET /visits/:id/file endpoint. It reuses the IStorageService key reversal
// (own-bucket segment rule) and adds the byte fetch, so a usecase composed
// with one adapter can resolve a stored URL to a key and stream it without
// ever handing a raw private-bucket URL to the frontend.
type ObjectReader interface {
	// ObjectKeyFromStoredURL reverses a stored absolute file URL back to its
	// bucket object key. The host is ignored and the bucket name in the path
	// decides, so the key always points into our own bucket. An empty URL, a
	// URL that does not expose our bucket segment, or a traversal-carrying URL
	// is refused.
	ObjectKeyFromStoredURL(rawURL string) (string, error)
	// OpenObject streams one stored object for inline serving. A missing key
	// is ErrNotFound.
	OpenObject(ctx context.Context, objectKey string) (ObjectContent, error)
}

// ProfileUpdate is the fully resolved body of a self-service profile write.
// The usecase resolves the final values first (an empty phone/avatar is sent as
// "" and the adapter stores SQL NULL), so the adapter performs a straight
// read-modify-write rather than a COALESCE patch. PasswordHash carries a fresh
// bcrypt hash when the caller rotates its own password ("" keeps the stored
// hash via COALESCE); the plaintext password never reaches this port.
type ProfileUpdate struct {
	Name         string
	Phone        string
	AvatarURL    string
	PasswordHash string
	// Email carries the account email for the write: a plain overwrite, so
	// the caller always resolves the final address first (read-modify-write,
	// never a partial patch). PATCH /auth/me passes the stored address back
	// through, which never carries email at all; only the email-change
	// confirm path passes a different address, after the token binding and
	// the freeness re-check both pass.
	Email string
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
	// ListSecurity returns the gate staff accounts for the given branch union.
	// isGlobal true means "every branch" and is reserved for super_admin; admin
	// and security callers pass isGlobal false with their branch union as
	// locationIDs so the adapter emits the scope-union predicate (PRD L110).
	ListSecurity(ctx context.Context, locationIDs []UUID, isGlobal bool) ([]User, error)
}

// UserAccountLookup is the smallest read port over the account directory that
// carries the joined ROLE NAME plus status. The visit create path uses it to
// prove a chosen vendor_user_id names an active vendor account before storing
// it. The PostgreSQL user adapter satisfies it through FindManagedByID, so no
// second adapter or query exists.
type UserAccountLookup interface {
	FindManagedByID(ctx context.Context, id UUID) (ManagedUser, error)
}

// UserLocationRepository is the branch-coverage port over user_locations
// (migration 000023). It is separate from UserRepository for the same reason
// ManagedUserRepository is (see admin.go): the older usecase/delivery fakes
// implement only the narrow ports, so widening UserRepository would break
// their compilation without changing behaviour. The PostgreSQL adapter
// satisfies both ports with one struct.
type UserLocationRepository interface {
	// ListUserLocationIDs returns the branch-coverage union of one user,
	// ordered for determinism. An empty (non-nil) slice means no coverage,
	// never global; a lookup failure is an error so callers fail closed.
	ListUserLocationIDs(ctx context.Context, userID UUID) ([]UUID, error)
}

// ProfileRepository is the self-service profile port. It is separate from
// UserRepository for the same reason ManagedUserRepository is (see admin.go):
// the older usecase/delivery fakes implement only the narrow ports, so
// widening UserRepository would break their compilation without changing
// behaviour. The PostgreSQL adapter satisfies both ports with one struct.
type ProfileRepository interface {
	// UpdateProfile writes the caller's own editable profile fields and returns
	// the complete refreshed user row. The caller resolves the final values;
	// this is a read-modify-write, not a partial patch.
	UpdateProfile(ctx context.Context, id UUID, update ProfileUpdate) (User, error)
}

// VisitSortBy is the whitelisted sort column for GET /visits. It is a closed
// vocabulary (never a raw string) so no caller can smuggle SQL into ORDER BY:
// the repository maps each value to a static CASE branch.
type VisitSortBy string

// Visit sort columns accepted via ?sort_by= (openapi GET /visits).
const (
	VisitSortCreatedAt VisitSortBy = "created_at"
	VisitSortStartDate VisitSortBy = "start_date"
	VisitSortEndDate   VisitSortBy = "end_date"
)

// Normalized returns the sort column, falling back to the legacy default
// (created_at) for empty or unknown values so invalid input can never reach SQL.
func (s VisitSortBy) Normalized() VisitSortBy {
	switch s {
	case VisitSortCreatedAt, VisitSortStartDate, VisitSortEndDate:
		return s
	default:
		return VisitSortCreatedAt
	}
}

// VisitSortOrder is the whitelisted sort direction for GET /visits.
type VisitSortOrder string

// Visit sort directions accepted via ?order= (openapi GET /visits).
const (
	VisitSortAsc  VisitSortOrder = "asc"
	VisitSortDesc VisitSortOrder = "desc"
)

// Normalized returns the sort direction, falling back to the legacy default
// (desc) for empty or unknown values.
func (o VisitSortOrder) Normalized() VisitSortOrder {
	switch o {
	case VisitSortAsc, VisitSortDesc:
		return o
	default:
		return VisitSortDesc
	}
}

// VisitFilter scopes a visit listing to the caller's branch union and role,
// which is how the backend enforces multi-branch isolation: admins and
// security pass their user_locations union (LocationIDs) with IsGlobal false,
// super_admin passes IsGlobal true for the national view or a single-id union
// with IsGlobal false to narrow by branch, and vendor passes its own user id.
// An empty union with IsGlobal false matches no branch (fail-closed), never
// the whole table: there is no unscoped listing except the explicit global.
// Page starts at 1; Limit caps the page size. Search is the optional
// free-text filter (ILIKE over vendor user name / visit_id in SQL); empty means
// unfiltered, never a widened scope. SortBy/Order select the ORDER BY column
// and direction; both are whitelisted vocabularies, never raw SQL, and the
// zero value means the legacy default (created_at desc).
type VisitFilter struct {
	LocationIDs  []UUID
	IsGlobal     bool
	VendorUserID *UUID
	Status       *VisitStatus
	Search       string
	From         *time.Time
	To           *time.Time
	Page         int
	Limit        int
	SortBy       VisitSortBy
	Order        VisitSortOrder
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
	// ListStatusHistory returns the actor-resolved status trail of one visit,
	// oldest -> newest, capped to the 50 newest rows. The current status note
	// is derivable from the newest event, so this is the single read behind
	// both VisitRequest.History and VisitRequest.StatusNote. An empty slice
	// means the visit has no history rows yet, never an error.
	ListStatusHistory(ctx context.Context, id UUID) ([]StatusEvent, error)
	List(ctx context.Context, filter VisitFilter) (visits []VisitRequest, total int64, err error)
	// ListVisitorJabatan returns the distinct, alphabetically sorted Jabatan
	// values already registered on visitor rows, with blanks dropped and the
	// list capped. The values are free text, never catalogue rows: the result
	// only feeds the roster combobox as suggestions.
	ListVisitorJabatan(ctx context.Context) ([]string, error)
	// UpdateStatus moves one visit to status and appends the history row in the
	// same transaction. It must lock the visit row first (SELECT ... FOR UPDATE)
	// so two concurrent approvals cannot both succeed, and it must translate
	// domain.ErrInvalidTransition-free callers' expectations: a status value
	// outside the eight-value vocabulary returns domain.ErrUnknownVisitStatus.
	UpdateStatus(ctx context.Context, id UUID, status VisitStatus, changedBy UUID, notes string) error
	// Reschedule writes the new window, flips the status to rescheduled and
	// appends the history row atomically; reason is stored as the history note.
	Reschedule(ctx context.Context, id UUID, start, end time.Time, changedBy UUID, reason string) error
	// UpdateVisitorContact corrects one roster member's phone number and its
	// persistent edited marker in ONE atomic row-locked write
	// (PATCH /visits/{id}/visitors/{visitorId}, migration 000021). The
	// caller resolves the final value AND the final flag first
	// (read-modify-write, never a partial patch): the adapter locks the
	// visitor row (SELECT ... FOR UPDATE), refuses a visitor that does not
	// belong to visitID with ErrNotFound, writes the columns verbatim and
	// returns the refreshed visitor. The flag is monotonic by contract:
	// callers only ever pass TRUE forward, never FALSE over a stored TRUE.
	UpdateVisitorContact(ctx context.Context, visitID, visitorID UUID, phone string, phoneEdited bool) (Visitor, error)
	// AttachWorkPhoto stores one before/after work proof
	// (POST /visits/{id}/work-photos, migration 000024). The adapter locks
	// the visit row first (SELECT ... FOR UPDATE), refuses any status but
	// visiting with a 409 conflict, then upserts on
	// UNIQUE (visit_request_id, kind): a re-attach replaces the row instead
	// of accumulating duplicates. The status check and the write happen in
	// ONE transaction so a concurrent check-out cannot let a photo land
	// after completion. The returned bool reports whether the row was
	// created (true, answer 201) or replaced (false, answer 200). A missing
	// visit is ErrNotFound; uploadedBy is the authenticated actor.
	// visitLogID binds the proof to one visit_logs cycle (migration 000034):
	// nil resolves to the latest 'in' log of the visit (NULL when the visit
	// has no log row yet), a foreign log id is a validation failure.
	AttachWorkPhoto(ctx context.Context, visitID UUID, kind WorkPhotoKind, url string, uploadedBy UUID, visitLogID *UUID) (WorkPhoto, bool, error)
	// ListWorkPhotos returns both work proofs of one visit (at most the
	// before and after rows), with the uploader display names resolved. A
	// visit without proofs yields an empty slice, never nil.
	ListWorkPhotos(ctx context.Context, visitID UUID) ([]WorkPhoto, error)
	// DeleteVisit removes one visit row in any status (DELETE /visits/:id,
	// super_admin only). The child tables (visitor, visit_purpose,
	// status_history, check_in, check_out) all carry ON DELETE CASCADE, so
	// the single-row delete cleans the roster, purposes, history and gate
	// records atomically. A missing id is ErrNotFound.
	DeleteVisit(ctx context.Context, id UUID) error
}

// VisitAutoRuleRepository is the read side of the background worker: each method
// returns the visits a single automatic rule currently matches, given the
// rule's threshold instant. The worker then re-asserts the match and applies the
// transition through VisitRepository.UpdateStatus so the history row is written
// by the same code path as a manual transition.
//
// The three rules come from the PRD state machine:
//
//	R1 status=requested and start_date <= before            -> cancelled  (window started, never approved)
//	R2 status in (requested,approved,rescheduled) and end_date < before and no check-in -> not_visit
//	R3 status=visiting  and end_date    < before            -> completed  (end_date + 24h)
//
// R4 (reminder) is the odd one out: it MUTATES NOTHING, so it takes an explicit
// [now, windowEnd] window and is listed separately below.
type VisitAutoRuleRepository interface {
	FindStaleRequested(ctx context.Context, before time.Time) ([]VisitRequest, error)
	FindNoShow(ctx context.Context, before time.Time) ([]VisitRequest, error)
	FindOverstayedVisiting(ctx context.Context, before time.Time) ([]VisitRequest, error)
	// FindUpcomingApproved returns approved visits whose start_date falls inside
	// (now, windowEnd]: the candidates for the pre-visit reminder (rule R4). The
	// worker then emits a reminder notification through NotificationRepository.
	FindUpcomingApproved(ctx context.Context, now, windowEnd time.Time) ([]VisitRequest, error)
}

// MasterDataRepository is the port serving the location and purpose
// catalogues both the admin console and the visit form consume.
type MasterDataRepository interface {
	ListLocations(ctx context.Context, onlyActive bool) ([]Location, error)
	FindLocationByID(ctx context.Context, id UUID) (Location, error)
	ListPurposes(ctx context.Context, onlyActive bool) ([]Purpose, error)
}

// VendorRepository is the narrow port behind GET /vendors: the active company
// catalogue the vendor/admin forms consume as the company dropdown. It is
// deliberately separate from MasterDataRepository (which the older handler
// fakes implement): the production masterRepository satisfies both, while the
// handler resolves it with a type assertion so narrow fakes keep compiling
// unchanged and fail closed with 500 instead of panicking.
type VendorRepository interface {
	ListVendors(ctx context.Context) ([]Vendor, error)
	// FindVendorName resolves one company name for display (auth profile).
	// A missing id is ErrNotFound; callers that tolerate absence (login/me)
	// treat it as an unnamed vendor rather than failing the request.
	FindVendorName(ctx context.Context, id UUID) (string, error)
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
