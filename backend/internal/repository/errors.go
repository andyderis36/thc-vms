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
		case "23503":
			return fmt.Errorf("repository: foreign key rejected reference: %w", domain.ErrValidation)
		}
	}
	return fmt.Errorf("repository: %w: %v", domain.ErrDatabase, err)
}
