package domain

import (
	"fmt"
	"time"
)

// VisitRequest mirrors the VISIT_REQUEST table: one vendor-submitted permission
// covering one facility, one schedule window and one or more visitors.
// VisitID is the VST-XXXXXXXXXX business code printed on the QR pass; Status
// moves only through the edges in status.go.
type VisitRequest struct {
	ID           UUID
	VisitID      string
	VendorUserID UUID
	// CreatedBy is the authenticated actor that SUBMITTED the row (migration
	// 000024), which differs from VendorUserID whenever an admin or superadmin
	// files the request on a vendor's behalf. Nil on rows written before the
	// migration was backfilled and on the create echo until the repository
	// maps it back.
	CreatedBy  *UUID
	VendorID   UUID
	LocationID   UUID
	// LocationName/LocationType adalah display name + tipe dari join
	// location (sudah diseleksi query list/detail, tanpa query tambahan).
	// Kosong berarti "lokasi tak dikenal" dan dirender "" di wire.
	LocationName string
	LocationType LocationType
	// VendorUserName/VendorUserEmail adalah display name + email dari join users
	// (sudah diseleksi query list/detail, tanpa query tambahan).
	// Kosong berarti "vendor user tak dikenal" dan dirender nil/omit di wire.
	VendorUserName string
	VendorUserEmail string
	// VendorUserVendorName adalah perusahaan milik akun vendor yang mengajukan
	// (COALESCE(users.vendor_name_override, vendor.name) dari join users +
	// vendor akun). Kosong berarti akun pengaju tidak membawa perusahaan dan
	// dirender nil/omit di wire.
	VendorUserVendorName string
	StartDate           time.Time
	EndDate             time.Time
	IsMultiDay          bool
	Status              VisitStatus
	AssignmentLetterURL *string
	IsNDAAccepted       bool
	Notes               *string
	// PurposeNote is the free-typed "tujuan lain" (migration 000005): a
	// *string like Notes so a stored NULL maps onto nil and renders as JSON
	// null on the VisitDetail purpose_note member. It never enters the
	// purpose catalogue: the dropdown reads purpose rows only.
	PurposeNote *string
	// StatusNote is the note of the current status transition (rejection,
	// cancellation, or reschedule reason). Best-effort display data loaded
	// from status_history on the single-GET path; nil when none.
	StatusNote *string
	// WorkPhotos carries the before/after work proofs for the GET /visits/{id}
	// work_photos member. It is populated ONLY on the single-GET path (the
	// list path leaves it nil so a page never pays the extra lookup); nil
	// means "not loaded", while a non-nil set with nil slots means "no proof
	// attached yet".
	WorkPhotos *WorkPhotoSet
	CreatedAt   time.Time
	UpdatedAt   time.Time
	// VendorName is the display name of VendorID resolved from the vendor
	// catalogue join. Empty means "no vendor or unknown" and renders as ""
	// in the openapi VisitDetail vendor_name member, unless VendorNameOverride
	// below carries the manual visit-level company (which then wins on the wire).
	VendorName string
	// VendorNameOverride is the manually typed visit-level company
	// (migration 000017, admin/superadmin-created visits): a *string so a
	// stored NULL maps one-to-one onto nil, mirroring PurposeNote. The wire
	// vendor_name renders this trimmed value when present, otherwise VendorName.
	VendorNameOverride *string
	// Visitors is the technician roster travelling under this request. It is
	// populated on single-visit reads and on paged lists (one batched query
	// per page); the create path echoes the request input instead because the
	// repository returns the visit row without its visitor rows.
	Visitors []Visitor
	// Purposes is the visit-reason catalogue attached through the
	// visit_purpose join. It mirrors the Visitors loading rule: single-visit
	// reads and paged lists populate it (one batched ListVisitPurposes query
	// per page); the create path echoes purpose-id shells instead because the
	// repository returns the visit row without its join rows.
	Purposes []Purpose
	// CheckInAt/CheckOutAt/CheckedInBy are GATE ENRICHMENT, not visit_request
	// columns: the single-GET usecase fills them from the check_in/check_out
	// tables (one row per visit). Nil means "no gate record yet" (requested /
	// approved). The list path leaves them nil on purpose so a 100-row page
	// never pays 200 extra lookups; see usecase/visit/detail.go.
	CheckInAt    *time.Time
	CheckOutAt   *time.Time
	CheckedInBy  *UUID
	CheckedOutBy *UUID
	// CreatedByName/CreatedByRoleLabel are the resolved display name and
	// Indonesian role label of CreatedBy: the "Diajukan oleh" row, resolved
	// by the single-GET read join (visit_request.created_by JOIN users/role)
	// and by the lifecycle email path. Nil means unresolved or no user row,
	// in which case the row is omitted rather than printing a bare UUID.
	CreatedByName      *string
	CreatedByRoleLabel *string
	// ActorName/ActorRoleLabel are the resolved display name and Indonesian
	// role label of the user who performed the transition this email announces
	// (email-only enrichment, never on the wire): the "Disetujui/Ditolak/
	// Diubah/Dibatalkan oleh" row. Nil means a system/worker transition, which
	// must not invent an actor.
	ActorName      *string
	ActorRoleLabel *string
	// CheckedInByName/CheckedOutByName are the resolved display names of the
	// gate actors (check_in/check_out JOIN users on the read path), filled by
	// the same single-GET enrichment as CheckInAt/CheckOutAt. Nil means no
	// gate record yet or an unresolvable account; list items stay nil.
	CheckedInByName  *string
	CheckedOutByName *string
	// History is the actor-resolved status trail, oldest -> newest, for the
	// GET /visits/{id} history member (the repository caps it to the 50
	// newest rows). Populated ONLY on the single-GET path, like WorkPhotos:
	// nil means "not loaded" (list items, create echo), a non-nil empty
	// slice means "loaded with no rows".
	History []StatusEvent
}

// Visitor mirrors the VISITOR table: one technician travelling under a
// visit request, identified by KTP/SIM/passport number. VendorID is the
// technician's own company (NULL for internal staff); VendorName is the
// RESOLVED display name (override-otherwise-catalogue), empty when none.
// VendorNameOverride is the manually typed company (migration 000005): a
// *string (not the VisitRequest.VendorID-style "" convention) so the stored
// NULL maps one-to-one onto nil, mirroring User.VendorNameOverride. A sent
// VendorID always wins: the create path discards the manual text instead of
// storing both, hence an override present implies no catalogue link.
type Visitor struct {
	ID                 UUID
	VisitRequestID     UUID
	Name               string
	IDNumber           string
	Phone              string
	IDCardPhotoURL     *string
	PhotoURL           *string
	VendorID           UUID
	VendorName         string
	VendorNameOverride *string
	// Jabatan is the optional free-text position of this visiting member
	// (migration 000012), e.g. "Teknisi", "Mandor", "Supervisor". It is NEVER a
	// catalogue entry: a *string so a blank input stays nil, and the values
	// typed earlier are offered back only as a suggestion list (GET /jabatan)
	// while the field stays freely editable.
	Jabatan   *string
	// Email is the optional member contact address (migration 000022) used
	// only as the notification-mail recipient. A *string so a stored NULL
	// maps onto nil; absence and empty both mean "no mail".
	Email     *string
	CreatedAt time.Time
	// PhoneEdited is the persistent marker of the creator contact correction
	// (migration 000021, PATCH /visits/{id}/visitors/{visitorId}): TRUE the
	// first time the owning vendor corrects the phone number and never
	// returns to FALSE. It renders on the wire as VisitorItem phone_edited.
	PhoneEdited bool
}

// VisitPurpose mirrors the VISIT_PURPOSE table: the composite link between a
// visit request and one catalogue purpose.
type VisitPurpose struct {
	VisitRequestID UUID
	PurposeID      UUID
}

// StatusHistory mirrors the STATUS_HISTORY table: the append-only audit trail
// of every status move, who made it and why.
type StatusHistory struct {
	ID             UUID
	VisitRequestID UUID
	Status         VisitStatus
	ChangedBy      UUID
	ChangedAt      time.Time
	Notes          *string
}

// StatusEvent is ONE actor-resolved status_history row as served on the
// GET /visits/{id} history member: which status was entered, when, and who
// performed the transition. ActorName/ActorRoleLabel are nil for a system
// transition (changed_by IS NULL) and for an unresolvable role, so the wire
// renders null and the UI drops the "oleh" clause instead of inventing an
// actor. Notes carries the transition note for the StatusNote derivation and
// is deliberately absent from the wire DTO.
type StatusEvent struct {
	Status         VisitStatus
	At             time.Time
	ActorName      *string
	ActorRoleLabel *string
	Notes          *string
}

// CheckIn mirrors the CHECK_IN table: the single gate record proving a visit
// entered the facility, executed by security or the branch admin.
type CheckIn struct {
	ID             UUID
	VisitRequestID UUID
	CheckedInAt    time.Time
	CheckedInBy    UUID
	// CheckedInByName is the resolved display name of CheckedInBy (read-path
	// users join), never a stored column; nil when unresolved.
	CheckedInByName *string
	PhotoURL        *string
	BadgeCode       *string
}

// CheckOut mirrors the CHECK_OUT table: the single gate record closing a
// visit, executed by security or the branch admin.
type CheckOut struct {
	ID             UUID
	VisitRequestID UUID
	CheckedOutAt   time.Time
	CheckedOutBy   UUID
	// CheckedOutByName is the resolved display name of CheckedOutBy (read-path
	// users join), never a stored column; nil when unresolved.
	CheckedOutByName *string
}

// WorkPhotoKind is the closed vocabulary of the visit_work_photo.kind column
// (migration 000024): exactly one "before" and one "after" evidence photo
// per visit, attached while the visit is being executed.
type WorkPhotoKind string

const (
	// WorkPhotoBefore proves the site condition before the work starts.
	WorkPhotoBefore WorkPhotoKind = "before"
	// WorkPhotoAfter proves the site condition after the work finishes.
	WorkPhotoAfter WorkPhotoKind = "after"
)

// ParseWorkPhotoKind converts a received string back into the closed
// vocabulary, refusing anything outside before/after.
func ParseWorkPhotoKind(raw string) (WorkPhotoKind, error) {
	switch WorkPhotoKind(raw) {
	case WorkPhotoBefore, WorkPhotoAfter:
		return WorkPhotoKind(raw), nil
	default:
		return "", fmt.Errorf("jenis bukti pengerjaan tidak dikenal: %q: %w", raw, ErrValidation)
	}
}

// WorkPhoto mirrors the VISIT_WORK_PHOTO table: one before/after evidence
// photo attached to a visit while it is being executed. UploadedBy is nil
// when the attaching account has since been removed (ON DELETE SET NULL);
// UploadedByName is the resolved display name ("" when unknown) and is
// display data only, never an identifier. VisitLogID binds the proof to the
// exact check-in/out cycle it was taken in (migration 000034, NULL on rows
// written before per-cycle binding); the UNIQUE (visit_request_id, kind)
// anchor is untouched, so a re-attach rebinds the slot to the current cycle.
type WorkPhoto struct {
	ID             UUID
	VisitRequestID UUID
	Kind           WorkPhotoKind
	URL            string
	UploadedBy     *UUID
	UploadedByName string
	UploadedAt     time.Time
	VisitLogID     *UUID
}

// WorkPhotoSet carries both evidence slots of one visit. A nil slot means
// "not attached yet" and renders as JSON null on the wire.
type WorkPhotoSet struct {
	Before *WorkPhoto
	After  *WorkPhoto
}
