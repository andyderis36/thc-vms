package repository

import (
	"fmt"
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

// textPtr converts a nullable text column back: NULL becomes nil.
func textPtr(t pgtype.Text) *string {
	if !t.Valid {
		return nil
	}
	out := t.String
	return &out
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
