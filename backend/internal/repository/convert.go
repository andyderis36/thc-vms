package repository

import (
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"thc-vms/backend/internal/domain"
)

// toDomainUUID converts a sqlc uuid.UUID to the domain identifier. The zero
// UUID means "no actor" and becomes the empty string, never the canonical
// "00000000-..." text, so callers can test for absence with a plain == "".
func toDomainUUID(id uuid.UUID) domain.UUID {
	if id == uuid.Nil {
		return ""
	}
	return domain.UUID(id.String())
}

// fromDomainUUID parses a domain identifier back to the driver type. The empty
// string means "no actor" and yields the zero UUID with no error; the caller
// decides whether that becomes SQL NULL (pgtype Valid=false) or a value.
func fromDomainUUID(id domain.UUID) (uuid.UUID, error) {
	if id == "" {
		return uuid.Nil, nil
	}
	parsed, err := uuid.Parse(string(id))
	if err != nil {
		return uuid.Nil, fmt.Errorf("repository: invalid UUID %q: %w: %v", id, domain.ErrValidation, err)
	}
	return parsed, nil
}

// mustDomainUUID is the non-failing variant for values the database just
// returned: they are well-formed by construction, so a parse failure would be
// a driver bug, and surfacing the zero value keeps the scan path total.
func mustDomainUUID(id uuid.UUID) domain.UUID {
	return toDomainUUID(id)
}

// pgNullUUID maps an optional domain identifier to a nullable driver UUID:
// empty means SQL NULL (automatic transition, no acting user).
func pgNullUUID(id domain.UUID) (pgtype.UUID, error) {
	if id == "" {
		return pgtype.UUID{Valid: false}, nil
	}
	parsed, err := fromDomainUUID(id)
	if err != nil {
		return pgtype.UUID{}, err
	}
	return pgtype.UUID{Bytes: parsed, Valid: true}, nil
}

// pgNullUUIDPtr maps an optional *domain.UUID the same way: nil means NULL.
func pgNullUUIDPtr(id *domain.UUID) (pgtype.UUID, error) {
	if id == nil || *id == "" {
		return pgtype.UUID{Valid: false}, nil
	}
	return pgNullUUID(*id)
}

// domainUUIDPtr converts a nullable driver UUID back: NULL becomes nil.
func domainUUIDPtr(id pgtype.UUID) *domain.UUID {
	if !id.Valid || id.Bytes == uuid.Nil {
		return nil
	}
	out := domain.UUID(uuid.UUID(id.Bytes).String())
	return &out
}

// pgText maps an optional string to a nullable text column.
func pgText(s *string) pgtype.Text {
	if s == nil {
		return pgtype.Text{Valid: false}
	}
	return pgtype.Text{String: *s, Valid: true}
}

// pgTextBlankNull maps an optional string to a nullable text column, storing
// SQL NULL for absent OR blank input. Member email uses it: "" means "no
// mail", so a blank write must persist NULL, never an empty string.
func pgTextBlankNull(s *string) pgtype.Text {
	if s == nil {
		return pgtype.Text{Valid: false}
	}
	if trimmed := strings.TrimSpace(*s); trimmed != "" {
		return pgtype.Text{String: trimmed, Valid: true}
	}
	return pgtype.Text{Valid: false}
}
// textPtr converts a nullable text column back: NULL becomes nil.
func textPtr(t pgtype.Text) *string {
	if !t.Valid {
		return nil
	}
	out := t.String
	return &out
}

// resolveVendorDisplayName renders the public vendor_name every read funnels
// through (visitor roster, managed-user console, auth profile): the manually
// typed company (migration 000005) when present, otherwise the catalogue
// name, "" when neither exists. The write paths never store both halves (a
// sent vendor_id discards the manual text), so an override present implies
// no catalogue link; a blank-but-valid override is treated as absent so a
// whitespace-only row can never shadow the catalogue. The manual value NEVER
// reaches the vendor catalogue/dropdown: ListActiveVendors reads the vendor
// table only, which these columns do not touch.
func resolveVendorDisplayName(override, catalogue pgtype.Text) string {
	if override.Valid && strings.TrimSpace(override.String) != "" {
		return strings.TrimSpace(override.String)
	}
	if catalogue.Valid {
		return catalogue.String
	}
	return ""
}

// resolveVendorDisplayPtr is the *string variant for projections whose
// vendor_name member is nullable on the wire (ManagedUser.VendorName,
// auth Profile.VendorName): nil renders as JSON null.
func resolveVendorDisplayPtr(override, catalogue pgtype.Text) *string {
	if name := resolveVendorDisplayName(override, catalogue); name != "" {
		out := name
		return &out
	}
	return nil
}

// pgTimestamptz maps an optional instant to a nullable timestamptz.
func pgTimestamptz(t *time.Time) pgtype.Timestamptz {
	if t == nil {
		return pgtype.Timestamptz{Valid: false}
	}
	return pgtype.Timestamptz{Time: *t, Valid: true}
}

// timePtr converts a nullable timestamptz back: NULL becomes nil.
func timePtr(t pgtype.Timestamptz) *time.Time {
	if !t.Valid {
		return nil
	}
	out := t.Time
	return &out
}
