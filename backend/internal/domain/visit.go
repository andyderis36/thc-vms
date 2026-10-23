package domain

import "time"

// VisitRequest mirrors the VISIT_REQUEST table: one vendor-submitted permission
// covering one facility, one schedule window and one or more visitors.
// VisitID is the VST-XXXXXXXXXX business code printed on the QR pass; Status
// moves only through the edges in status.go.
type VisitRequest struct {
	ID           UUID
	VisitID      string
	VendorUserID UUID
	VendorID     UUID
	LocationID   UUID
	// LocationName/LocationType adalah display name + tipe dari join
	// location (sudah diseleksi query list/detail, tanpa query tambahan).
	// Kosong berarti "lokasi tak dikenal" dan dirender "" di wire.
	LocationName string
	LocationType LocationType
	// VendorUserName/VendorUserEmail adalah display name + email dari join users
	// (sudah diseleksi query list/detail, tanpa query tambahan).
	// Kosong berarti "vendor user tak dikenal" dan dirender nil/omit di wire.
	VendorUserName      string
	VendorUserEmail     string
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
	CreatedAt   time.Time
	UpdatedAt   time.Time
	// VendorName is the display name of VendorID resolved from the vendor
	// catalogue join. Empty means "no vendor or unknown" and renders as ""
	// in the openapi VisitDetail vendor_name member.
	VendorName string
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
	CheckInAt   *time.Time
	CheckOutAt  *time.Time
	CheckedInBy *UUID
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
	CreatedAt time.Time
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

// CheckIn mirrors the CHECK_IN table: the single gate record proving a visit
// entered the facility, executed by security or the branch admin.
type CheckIn struct {
	ID             UUID
	VisitRequestID UUID
	CheckedInAt    time.Time
	CheckedInBy    UUID
	PhotoURL       *string
	BadgeCode      *string
}

// CheckOut mirrors the CHECK_OUT table: the single gate record closing a
// visit, executed by security or the branch admin.
type CheckOut struct {
	ID             UUID
	VisitRequestID UUID
	CheckedOutAt   time.Time
	CheckedOutBy   UUID
}
