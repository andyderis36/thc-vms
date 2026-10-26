package repository

import (
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"thc-vms/backend/internal/domain"
)

// MapError translates a pgx/pgconn failure into the domain sentinel the
// delivery layer funnels onto HTTP statuses. Matching is by errors.Is/As and
// SQLSTATE code only, never by message text.
func MapError(err error) error {
	if err == nil {
		return nil
	}
	for _, sentinel := range []error{
		domain.ErrNotFound,
		domain.ErrConflict,
		domain.ErrValidation,
		domain.ErrInvalidTransition,
		domain.ErrUnknownVisitStatus,
		domain.ErrDatabase,
	} {
		if errors.Is(err, sentinel) {
			return err
		}
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("repository: row missing: %w", domain.ErrNotFound)
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			return fmt.Errorf("repository: uniqueness clash: %w", domain.ErrConflict)
		case "23514":
			return fmt.Errorf("repository: check constraint rejected value: %w", domain.ErrValidation)
		case "22001":
			// string_data_right_truncation: the value is longer than the
			// column allows. That is a malformed field (the handler-side
			// limits should have caught it), not an infrastructure fault.
			return fmt.Errorf("repository: value exceeds column length: %w", domain.ErrValidation)
		case "23503":
			// A surviving reference blocks the write: the row is still
			// needed elsewhere, which is a state clash (409), not a
			// malformed field. This is the second line of defence behind
			// the Go pre-check counts on the DELETE paths; the trigger
			// invariant keeps raising 23514 (-> 400) for bad pairings.
			return fmt.Errorf("repository: foreign key rejected reference: %w", domain.ErrConflict)
		}
	}
	return fmt.Errorf("repository: %w: %v", domain.ErrDatabase, err)
}
