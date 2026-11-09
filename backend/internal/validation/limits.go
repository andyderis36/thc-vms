// Package validation is the single source of truth for input limits and the
// pure field validators every layer shares. The constants mirror the
// x-limits block in docs/4. openapi.yaml (also mirrored by
// frontend/src/lib/limits.ts); limits_contract_test.go pins that equality so a
// limit can never drift between backend, contract and frontend.
//
// The helpers here are pure functions: no HTTP, no database, no logging. The
// delivery layer turns a false/error result into its own envelope, which keeps
// validation reusable from handlers, usecases and tests alike.
package validation

// Field length and format limits. Values MUST match x-limits in
// docs/4. openapi.yaml.
const (
	// NameMaxLength caps person names (visitor, vendor contact).
	NameMaxLength = 100
	// IDNumberPattern is the accepted identity-document shape (KTP/SIM).
	IDNumberPattern = `^[A-Za-z0-9]{8,20}$`
	// IDNumberMaxLength is the stored identity-document ceiling.
	IDNumberMaxLength = 20
	// PhonePattern is the Indonesian phone shape after normalization.
	PhonePattern = `^(?:62|0)[0-9]{9,15}$`
	// PhoneMinLength is the minimum normalized phone digit count.
	PhoneMinLength = 10
	// PhoneMaxLength caps the normalized phone string.
	PhoneMaxLength = 16
	// PasswordMinLength is the minimum password rune count.
	PasswordMinLength = 8
	// PasswordMaxBytes is bcrypt's hard input ceiling.
	PasswordMaxBytes = 72
	// EmailMaxLength caps the trimmed email address.
	EmailMaxLength = 254
	// TextMaxLength caps free-text notes and descriptions.
	TextMaxLength = 1000
	// RejectReasonMinLength is the shortest acceptable rejection reason.
	RejectReasonMinLength = 5
	// FacilityNameMaxLength caps a location/facility name.
	FacilityNameMaxLength = 100
	// FacilityAddressMaxLength caps a facility address.
	FacilityAddressMaxLength = 255
	// FacilityCityMaxLength caps a facility city.
	FacilityCityMaxLength = 100
	// PurposeNameMaxLength caps a visit-purpose catalogue name.
	PurposeNameMaxLength = 100
	// VisitIDInputMaxLength caps the manual visit-ID scanner input.
	VisitIDInputMaxLength = 64
	// BadgeCodeMaxLength caps a badge code.
	BadgeCodeMaxLength = 64
	// CheckinNotesMaxLength caps check-in notes.
	CheckinNotesMaxLength = 500
	// SearchQueryMaxLength caps a free-text search query.
	SearchQueryMaxLength = 100
	// SuggestionQueryMaxLength caps the ?q= filter on the vendor/member
	// suggestion endpoints; a longer value is refused, never truncated.
	SuggestionQueryMaxLength = 80
	// VendorNameMaxLength caps a vendor/company name.
	VendorNameMaxLength = 120
	// JabatanMaxLength caps a roster position label.
	JabatanMaxLength = 120
	// PurposeNoteMaxLength caps the note attached to a visit purpose.
	PurposeNoteMaxLength = 200
	// NIKLength is the fixed Indonesian NIK digit count.
	NIKLength = 16
	// TechniciansMax caps the technicians attached to one visit.
	TechniciansMax = 10
	// JSONBodyMaxBytes caps a JSON request body (1 MiB).
	JSONBodyMaxBytes = 1 << 20
	// UploadStoredMaxBytes caps the bytes actually persisted (5 MiB, AGENTS.md
	// section 6.4) after the browser compresses images and the server optimises
	// PDFs. Echoed by the MAX_UPLOAD_SIZE_MB environment variable.
	UploadStoredMaxBytes = 5 << 20
	// UploadIngestMaxBytes caps the raw bytes a client may transport (20 MiB),
	// echoed by the MAX_UPLOAD_INGEST_MB environment variable. Two ceilings
	// exist because compression sits between transport and storage: a 20 MB PDF
	// can legitimately shrink below 5 MB, so the stored cap must not bound the
	// request body, and the transport cap must never sit below the stored cap.
	UploadIngestMaxBytes = 20 << 20
)
