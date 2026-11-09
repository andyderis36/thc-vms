package domain

import (
	"context"
	"time"
)

// VendorSuggestionSource is the closed priority vocabulary behind the vendor
// identity suggestions (GET /vendors/suggestions). A name that appears in more
// than one source keeps the HIGHEST priority (lowest ordinal): the master
// catalogue wins over an account-level manual company, which wins over visit
// history. The value is serialised verbatim on the wire.
type VendorSuggestionSource string

const (
	// VendorSuggestionSourceMaster is a name from the active vendor catalogue.
	VendorSuggestionSourceMaster VendorSuggestionSource = "master"
	// VendorSuggestionSourceAccount is a manual company typed on a vendor-role
	// account (users.vendor_name_override).
	VendorSuggestionSourceAccount VendorSuggestionSource = "account"
	// VendorSuggestionSourceHistory is a company name seen on a visit request
	// (visit_request.vendor_name_override or the catalogue join).
	VendorSuggestionSourceHistory VendorSuggestionSource = "history"
)

// VendorSuggestion is one deduped company suggestion. Name keeps the display
// casing of the winning source; Source names where it came from.
type VendorSuggestion struct {
	Name   string
	Source VendorSuggestionSource
}

// VendorSuggestionFilter carries the resolved scope for the vendor feed.
// IsGlobal true means the national view (super_admin); otherwise LocationIDs is
// the caller's branch union and an empty union matches no row (fail-closed).
// Query is the optional trimmed prefix filter.
type VendorSuggestionFilter struct {
	IsGlobal    bool
	LocationIDs []UUID
	Query       string
}

// MemberSuggestionFilter carries the resolved scope for the member reuse feed.
// Exactly one of VendorUserID (vendor ownership) or the branch pair
// (IsGlobal/LocationIDs) is meaningful: the vendor variant ignores the branch
// fields, the branch variant ignores VendorUserID. VendorName is the optional
// display-name narrow for the branch/global variant only (a vendor caller never
// supplies it). Query is the optional trimmed name filter.
type MemberSuggestionFilter struct {
	IsGlobal     bool
	LocationIDs  []UUID
	VendorUserID *UUID
	VendorName   string
	Query        string
}

// MemberSuggestion is one reuse candidate from prior visits. It is
// deliberately photo-less: the list endpoint carries plain contact data, while
// the single-member pick endpoint adds the presigned photo links. VisitorID is
// the winning dedupe row itself, so the client can resolve the detail endpoint
// directly without re-searching.
type MemberSuggestion struct {
	Name          string
	IDNumber      string
	Phone         string
	Email         *string
	Jabatan       *string
	LastVisitAt   time.Time
	VisitorID     UUID
	SourceVisitID UUID
}

// MemberSuggestionDetail is the single picked member with its presigned photo
// links for autofill. Photo pointers stay nil when the member has no stored
// photo or the storage adapter cannot sign it. VendorName is the member's OWN
// company (visitor override > catalogue), never the visit-level "Vendor
// Pengaju".
type MemberSuggestionDetail struct {
	Name           string
	IDNumber       string
	Phone          string
	Email          *string
	Jabatan        *string
	VendorName     *string
	IDCardPhotoURL *string
	PhotoURL       *string
	SourceVisitID  UUID
}

// SuggestionRepository is the read-only port behind the suggestion feeds. It is
// deliberately separate from VisitRepository so the worker/handler fakes keep
// their narrow surface; the PostgreSQL visit adapter satisfies both.
type SuggestionRepository interface {
	// ListVendorSuggestions returns the raw, scope-filtered vendor-name
	// sources (possibly duplicated across sources); the usecase owns the
	// dedupe/priority merge.
	ListVendorSuggestions(ctx context.Context, filter VendorSuggestionFilter) ([]VendorSuggestion, error)
	// ListMemberSuggestions returns the scoped member candidates, already
	// deduped by (name, phone) on the newest visit and capped by the adapter.
	ListMemberSuggestions(ctx context.Context, filter MemberSuggestionFilter) ([]MemberSuggestion, error)
	// FindVisitorByID resolves one roster member by primary key. The caller
	// applies the visit read scope before returning anything to the client.
	FindVisitorByID(ctx context.Context, id UUID) (Visitor, error)
}
