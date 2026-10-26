package repository

import (
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"thc-vms/backend/internal/domain"
)

func TestMapError_ColumnLengthIsValidation(t *testing.T) {
	err := MapError(&pgconn.PgError{Code: "22001"})
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("MapError(22001) = %v, want domain.ErrValidation", err)
	}
	if errors.Is(err, domain.ErrDatabase) {
		t.Fatalf("MapError(22001) must not fall through to domain.ErrDatabase")
	}
}
