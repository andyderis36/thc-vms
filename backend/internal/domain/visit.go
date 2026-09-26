package domain

import "time"

// VisitRequest mirrors the VISIT_REQUEST table: one PIC-submitted permission
// covering one facility, one schedule window and one or more visitors.
// VisitID is the VST-XXXXXXXXXX business code printed on the QR pass; Status
// moves only through the edges in status.go.
type VisitRequest struct {
	ID                  UUID
	VisitID             string
	PICUserID           UUID
	VendorID            UUID
	LocationID          UUID
	StartDate           time.Time
	EndDate             time.Time
	IsMultiDay          bool
	Status              VisitStatus
	AssignmentLetterURL *string
	IsNDAAccepted       bool
	Notes               *string
	CreatedAt           time.Time
	UpdatedAt           time.Time
}

// Visitor mirrors the VISITOR table: one technician travelling under a
// visit request, identified by KTP/SIM/passport number.
type Visitor struct {
	ID             UUID
	VisitRequestID UUID
	Name           string
	IDNumber       string
	Phone          string
	IDCardPhotoURL *string
	PhotoURL       *string
	CreatedAt      time.Time
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
