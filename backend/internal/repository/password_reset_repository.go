package repository

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"thc-vms/backend/internal/domain"
)

// passwordResetTokenRepository is the PostgreSQL adapter for
// domain.PasswordResetTokenRepository (migration 000029). It uses hand-written
// SQL instead of the generated db.Querier: the table is a narrow
// insert-plus-atomic-consume pair with a FOR UPDATE lock, so a new sqlc query
// set plus regeneration would add surface without adding safety — the same
// reason mail_log_repository.go stays hand-written.
type passwordResetTokenRepository struct {
	pool *pgxpool.Pool
}

var _ domain.PasswordResetTokenRepository = (*passwordResetTokenRepository)(nil)

// NewPasswordResetTokenRepository builds the PostgreSQL-backed
// domain.PasswordResetTokenRepository.
func NewPasswordResetTokenRepository(pool *pgxpool.Pool) domain.PasswordResetTokenRepository {
	return &passwordResetTokenRepository{pool: pool}
}

// InsertToken stores one issued token digest: the owning user, the SHA-256 hex
// digest of the raw bearer (the raw token is never persisted), its expiry,
// and the request IP (nil when the caller runs without an HTTP request). A
// digest collision is ErrConflict through MapError; the 256-bit space makes
// that a retryable anomaly, never a user error the usecase special-cases.
func (r *passwordResetTokenRepository) InsertToken(ctx context.Context, userID domain.UUID, tokenHash string, expiresAt time.Time, requestedIP *string) error {
	parsed, err := fromDomainUUID(userID)
	if err != nil {
		return err
	}
	_, err = r.pool.Exec(ctx, `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, requested_ip)
		VALUES ($1, $2, $3, $4)`, parsed, tokenHash, expiresAt, requestedIP)
	if err != nil {
		return MapError(err)
	}
	return nil
}

// ConsumeToken redeems one token atomically: it locks the unconsumed,
// unexpired row (token_hash match AND expires_at > now AND consumed_at IS
// NULL), stamps consumed_at, and rotates the owner's bcrypt password hash in
// ONE transaction. A missing, consumed, or expired row is ErrNotFound so the
// usecase renders every failure as the single byte-identical 401; the row
// lock serialises two concurrent confirms, the loser finding nothing left to
// consume. affected guards the consumed stamp and the password write alike:
// a zero count where the lock just succeeded is a data-integrity break that
// fails the transaction rather than half-redeeming the token.
func (r *passwordResetTokenRepository) ConsumeToken(ctx context.Context, tokenHash, newPasswordHash string, now time.Time) (domain.UUID, error) {
	var userID domain.UUID
	err := WithTx(ctx, r.pool, func(tx pgx.Tx) error {
		var rawUserID uuid.UUID
		if err := tx.QueryRow(ctx, `SELECT user_id FROM password_reset_tokens
			WHERE token_hash = $1 AND expires_at > $2 AND consumed_at IS NULL
			FOR UPDATE`, tokenHash, now).Scan(&rawUserID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return domain.ErrNotFound
			}
			return MapError(err)
		}
		userID = mustDomainUUID(rawUserID)
		parsed, err := fromDomainUUID(userID)
		if err != nil {
			return err
		}
		stamp, err := tx.Exec(ctx, `UPDATE password_reset_tokens SET consumed_at = $2
			WHERE token_hash = $1 AND consumed_at IS NULL`, tokenHash, now)
		if err != nil {
			return MapError(err)
		}
		if stamp.RowsAffected() != 1 {
			return domain.ErrNotFound
		}
		rotated, err := tx.Exec(ctx, `UPDATE users SET password_hash = $2, updated_at = now()
			WHERE id = $1`, parsed, newPasswordHash)
		if err != nil {
			return MapError(err)
		}
		if rotated.RowsAffected() != 1 {
			return domain.ErrNotFound
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	return userID, nil
}
