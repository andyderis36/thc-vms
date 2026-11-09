package domain

import (
	"errors"
	"fmt"
	"net/http"
)

// Sentinel errors shared by every layer. The three user-facing messages are
// fixed verbatim by the PRD and openapi contract; the rest are Bahasa
// Indonesia defaults the envelope projects onto HTTP statuses.
var (
	// ErrInvalidCredentials backs the 401 login failure: "Kredensial tidak valid".
	ErrInvalidCredentials = errors.New("Kredensial tidak valid")
	// ErrAccountPending backs the 403 login refusal for pending accounts
	// (self-registered vendors waiting for superadmin approval): the account
	// exists and the password was right, but it may not sign in yet.
	ErrAccountPending = errors.New("Akun Anda menunggu persetujuan superadmin.")
	// ErrAccountInactive backs the 403 login refusal for inactive accounts
	// (deactivated veterans): the account exists and the password was right,
	// but it has been deactivated.
	ErrAccountInactive = errors.New("Akun Anda dinonaktifkan.")
	// ErrForbiddenBranch backs the 403 cross-branch refusal.
	ErrForbiddenBranch = errors.New("Tidak berhak mengelola kunjungan cabang lain")
	// ErrForbidden backs 403 refusals whose reason is the caller's ROLE rather
	// than a branch boundary (e.g. a vendor naming another vendor's account).
	ErrForbidden = errors.New("Operasi tidak diizinkan untuk peran Anda.")
	// ErrCheckInWindow backs the 400 check-in refusal, PRD L123 verbatim, used
	// for ANY tolerance-window violation, too early as well as too late.
	ErrCheckInWindow = errors.New("Kunjungan belum dibuka atau sudah melewati batas waktu toleransi.")
	// ErrUnauthorized backs the 401 for missing or expired tokens.
	ErrUnauthorized = errors.New("Token tidak valid atau kedaluwarsa.")
	// ErrNotFound marks a missing row.
	ErrNotFound = errors.New("data tidak ditemukan")
	// ErrConflict marks a uniqueness or state clash.
	ErrConflict = errors.New("data bentrok dengan kondisi saat ini")
	// ErrValidation marks a rejected field value.
	ErrValidation = errors.New("validasi gagal")
	// ErrStorageRejected marks an upload refused for size or MIME type.
	ErrStorageRejected = errors.New("berkas ditolak: ukuran atau tipe tidak diizinkan")
	// ErrDatabase marks an infrastructure persistence failure.
	ErrDatabase = errors.New("kesalahan penyimpanan data")
	// ErrUnknownVisitStatus marks a status outside the eight-value vocabulary.
	ErrUnknownVisitStatus = errors.New("status kunjungan tidak dikenal")
	// ErrInvalidTransition marks a refused state-machine move.
	ErrInvalidTransition = errors.New("transisi status kunjungan tidak diizinkan")
)

// AppError is the single error shape every layer returns upward. It carries
// the HTTP status and the machine code the delivery layer writes into the
// mandated failure envelope, while Err keeps the root cause for server logs
// and stays out of the client response.
type AppError struct {
	Status  int
	Code    string
	Message string
	Err     error
}

// Error renders the user message plus the wrapped cause for logs. The cause
// never reaches the client: the envelope only serialises Code and Message.
func (e *AppError) Error() string {
	if e.Err == nil {
		return e.Message
	}
	return e.Message + ": " + e.Err.Error()
}

// Unwrap exposes the root cause so errors.Is and errors.As keep working.
func (e *AppError) Unwrap() error {
	return e.Err
}

// FileTooLargeError marks a payload that exceeds one of the upload ceilings.
// Limit is the byte count that was violated: the transport ceiling (what the
// request may carry before compression) or the stored ceiling (what the bucket
// may hold afterwards). Cause keeps the compression failure that made a large
// original unusable, without leaking it into the client message.
type FileTooLargeError struct {
	Limit int64
	Cause error
}

// Error renders the user-facing refusal. The message is part of the API
// contract, so it always names the exact byte limit that was exceeded.
func (e *FileTooLargeError) Error() string {
	return fmt.Sprintf("Ukuran berkas melebihi batas %d byte.", e.Limit)
}

// Unwrap exposes the underlying cause so errors.Is and errors.As keep working.
func (e *FileTooLargeError) Unwrap() error {
	return e.Cause
}

// InvalidCredentials builds the 401 login failure.
func InvalidCredentials() *AppError {
	return &AppError{
		Status:  http.StatusUnauthorized,
		Code:    "INVALID_CREDENTIALS",
		Message: ErrInvalidCredentials.Error(),
		Err:     ErrInvalidCredentials,
	}
}

 	// AccountPending builds the 403 login refusal for pending accounts.
func AccountPending() *AppError {
	return &AppError{
		Status:  http.StatusForbidden,
		Code:    "ACCOUNT_PENDING",
		Message: ErrAccountPending.Error(),
		Err:     ErrAccountPending,
	}
}

// AccountInactive builds the 403 login refusal for inactive accounts.
func AccountInactive() *AppError {
	return &AppError{
		Status:  http.StatusForbidden,
		Code:    "ACCOUNT_INACTIVE",
		Message: ErrAccountInactive.Error(),
		Err:     ErrAccountInactive,
	}
}

// ForbiddenBranch builds the 403 cross-branch refusal.
func ForbiddenBranch() *AppError {
	return &AppError{
		Status:  http.StatusForbidden,
		Code:    "FORBIDDEN_BRANCH",
		Message: ErrForbiddenBranch.Error(),
		Err:     ErrForbiddenBranch,
	}
}

// Forbidden builds a 403 for a role-level refusal, carrying the caller's
// diagnosis while keeping the generic FORBIDDEN code family.
func Forbidden(message string) *AppError {
	return &AppError{
		Status:  http.StatusForbidden,
		Code:    "FORBIDDEN",
		Message: message,
		Err:     ErrForbidden,
	}
}

// CheckInWindowExceeded builds the 400 tolerance-window refusal.
func CheckInWindowExceeded() *AppError {
	return &AppError{
		Status:  http.StatusBadRequest,
		Code:    "CHECKIN_WINDOW_EXCEEDED",
		Message: ErrCheckInWindow.Error(),
		Err:     ErrCheckInWindow,
	}
}

// NotFoundEntity builds a 404 for one missing entity, e.g. NotFoundEntity("Kunjungan").
func NotFoundEntity(entity string) *AppError {
	return &AppError{
		Status:  http.StatusNotFound,
		Code:    "NOT_FOUND",
		Message: entity + " tidak ditemukan.",
		Err:     ErrNotFound,
	}
}

// Conflict builds a 409 carrying the caller's diagnosis.
func Conflict(message string) *AppError {
	return &AppError{
		Status:  http.StatusConflict,
		Code:    "CONFLICT",
		Message: message,
		Err:     ErrConflict,
	}
}

// ValidationFailure builds a 422 carrying the caller's field diagnosis.
func ValidationFailure(message string) *AppError {
	return &AppError{
		Status:  http.StatusUnprocessableEntity,
		Code:    "VALIDATION_ERROR",
		Message: message,
		Err:     ErrValidation,
	}
}

// FromError funnels any error into an *AppError: known sentinels (even deeply
// wrapped) become their fixed status, code and user message, while anything
// unrecognised becomes a generic 500 that hides the cause from the client.
func FromError(err error) *AppError {
	if err == nil {
		return nil
	}
	var appErr *AppError
	if errors.As(err, &appErr) {
		return appErr
	}
	var tooLarge *FileTooLargeError
	if errors.As(err, &tooLarge) {
		return &AppError{
			Status:  http.StatusRequestEntityTooLarge,
			Code:    "FILE_TOO_LARGE",
			Message: tooLarge.Error(),
			Err:     err,
		}
	}
	switch {
	case errors.Is(err, ErrInvalidCredentials):
		return InvalidCredentials()
	case errors.Is(err, ErrAccountPending):
		return AccountPending()
	case errors.Is(err, ErrAccountInactive):
		return AccountInactive()
	case errors.Is(err, ErrForbiddenBranch):
		return ForbiddenBranch()
	case errors.Is(err, ErrForbidden):
		return &AppError{Status: http.StatusForbidden, Code: "FORBIDDEN", Message: ErrForbidden.Error(), Err: err}
	case errors.Is(err, ErrCheckInWindow):
		return CheckInWindowExceeded()
	case errors.Is(err, ErrUnauthorized):
		return &AppError{Status: http.StatusUnauthorized, Code: "UNAUTHORIZED", Message: ErrUnauthorized.Error(), Err: err}
	case errors.Is(err, ErrNotFound):
		return &AppError{Status: http.StatusNotFound, Code: "NOT_FOUND", Message: "Data yang diminta tidak ditemukan.", Err: err}
	case errors.Is(err, ErrConflict):
		return &AppError{Status: http.StatusConflict, Code: "CONFLICT", Message: "Permintaan bentrok dengan kondisi data saat ini.", Err: err}
	case errors.Is(err, ErrInvalidTransition):
		return &AppError{Status: http.StatusConflict, Code: "INVALID_TRANSITION", Message: "Transisi status kunjungan tidak diizinkan.", Err: err}
	case errors.Is(err, ErrValidation):
		return &AppError{Status: http.StatusUnprocessableEntity, Code: "VALIDATION_ERROR", Message: "Data yang dikirim tidak valid.", Err: err}
	case errors.Is(err, ErrStorageRejected):
		return &AppError{Status: http.StatusBadRequest, Code: "STORAGE_REJECTED", Message: ErrStorageRejected.Error(), Err: err}
	default:
		return &AppError{Status: http.StatusInternalServerError, Code: "INTERNAL_ERROR", Message: "Terjadi kesalahan pada server.", Err: err}
	}
}
