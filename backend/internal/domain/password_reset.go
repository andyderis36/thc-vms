package domain

import (
	"context"
	"net/http"
	"net/mail"
	"strings"
	"time"
	"unicode/utf8"
)

// PasswordResetTokenTTL adalah masa berlaku satu token reset kata sandi: 30
// menit sejak diterbitkan. Usecase W2-T6 membangun kontraknya di atas
// konstanta ini (token = opaque crypto/rand yang disimpan sebagai SHA-256 hex
// di tabel password_reset_tokens); crypto/rand + bcrypt hidup di
// usecase/infrastructure, bukan di sini.
const PasswordResetTokenTTL = 30 * time.Minute

// passwordResetEmailMaxLength membatasi alamat yang dipangkas, cermin dari
// aturan validation.ValidEmail yang dipakai seluruh jalur auth: satu alamat
// mailbox polos tanpa display-name.
const passwordResetEmailMaxLength = 254

// PasswordResetRequest adalah input ternormalisasi permintaan reset: satu
// alamat email yang sudah dipangkas dan dikecilkan hurufnya.
type PasswordResetRequest struct {
	Email string
}

// PasswordResetConfirm adalah input konfirmasi reset: token opaque dari
// tautan email plus kata sandi baru pilihan pemohon. Kebijakan kata sandi
// (minimal 8 karakter) ditegakkan validation.ValidPassword di usecase.
type PasswordResetConfirm struct {
	Token       string
	NewPassword string
}

// NormalizePasswordResetEmail memangkas spasi dan mengecilkan huruf alamat,
// cermin dari normalisasi login dan email-change: "  Foo@Example.COM " menjadi
// "foo@example.com".
func NormalizePasswordResetEmail(raw string) string {
	return strings.ToLower(strings.TrimSpace(raw))
}

// ValidPasswordResetEmail melaporkan apakah alamat yang sudah dinormalisasi
// adalah mailbox polos: tidak kosong, maksimal 254 rune, terurai oleh
// net/mail, dan persis sama dengan hasil uraiannya (bentuk display-name
// seperti "A <a@b.co>" ditolak karena hasil uraiannya berbeda dari input).
func ValidPasswordResetEmail(normalised string) bool {
	if normalised == "" || utf8.RuneCountInString(normalised) > passwordResetEmailMaxLength {
		return false
	}
	addr, err := mail.ParseAddress(normalised)
	if err != nil {
		return false
	}
	return addr.Address == normalised
}

// ValidatePasswordResetRequest menormalisasi lalu memeriksa alamat pemohon.
// Alamat yang bentuknya salah menjadi 422 VALIDATION_ERROR yang pesannya
// meminjam nada superadmin yang sudah mapan ("Format email tidak valid."),
// bukan pesan baru, supaya envelope tetap satu kosakata.
func ValidatePasswordResetRequest(raw string) (PasswordResetRequest, error) {
	normalised := NormalizePasswordResetEmail(raw)
	if !ValidPasswordResetEmail(normalised) {
		return PasswordResetRequest{}, ValidationFailure("Format email tidak valid.")
	}
	return PasswordResetRequest{Email: normalised}, nil
}

// PasswordResetLinkInvalid membangun satu-satunya respons gagal konfirmasi
// reset: token kedaluwarsa, terpakai, asing, atau rusak semuanya dirender
// byte-identik 401 UNAUTHORIZED ("Tautan tidak valid atau kedaluwarsa.",
// nada yang sama dengan confirm ganti email) sehingga endpoint tidak pernah
// menjadi account oracle. Akar penyebabnya tetap ErrUnauthorized supaya
// FromError memetakan sentinel yang dibungkus ke envelope yang sama.
func PasswordResetLinkInvalid() *AppError {
	return &AppError{
		Status:  http.StatusUnauthorized,
		Code:    "UNAUTHORIZED",
		Message: "Tautan tidak valid atau kedaluwarsa.",
		Err:     ErrUnauthorized,
	}
}

// PasswordResetExpiresAt adalah helper murni domain: batas kedaluwarsa satu
// token yang diterbitkan pada issued. Tidak menyentuh jam dinding supaya
// usecase mengujinya dengan Clock beku.
func PasswordResetExpiresAt(issued time.Time) time.Time {
	return issued.Add(PasswordResetTokenTTL)
}

// PasswordResetTokenExpired melaporkan apakah now sudah melewati
// kedaluwarsa token: issued + TTL. Perbandingan eksklusif (now.After, bukan
// !Before) supaya detik ke-1800 tepat masih diterima.
func PasswordResetTokenExpired(issued, now time.Time) bool {
	return now.After(PasswordResetExpiresAt(issued))
}

// PasswordResetTokenRepository adalah port penyimpanan token reset kata sandi
// opaque sekali pakai (migration 000029). Adapter PostgreSQL memenuhinya
// dengan SQL tulis-tangan: pasangan insert-plus-consume yang sempit dengan
// kunci FOR UPDATE, sehingga satu set query sqlc baru plus regenerasi hanya
// menambah permukaan tanpa menambah keamanan — alasan yang sama
// mail_log_repository.go tetap tulis-tangan.
//
// InsertToken menyimpan satu digest terbitan: user pemilik, digest hex
// SHA-256 dari token mentah (token mentah tidak pernah disimpan), batas
// kedaluwarsa, dan IP pemohon yang boleh nil. ConsumeToken menebus satu token
// secara atomik: ia mengunci baris yang belum terpakai dan belum kedaluwarsa
// (token_hash cocok DAN expires_at > now DAN consumed_at IS NULL), menstempel
// consumed_at, dan memutar hash bcrypt kata sandi pemiliknya dalam SATU
// transaksi yang sama. Baris yang hilang, terpakai, atau kedaluwarsa menjadi
// ErrNotFound supaya pemanggil memetakan semua kasus gagal ke satu 401 yang
// byte-identik dan endpoint tidak pernah menjadi account oracle.
type PasswordResetTokenRepository interface {
	InsertToken(ctx context.Context, userID UUID, tokenHash string, expiresAt time.Time, requestedIP *string) error
	ConsumeToken(ctx context.Context, tokenHash, newPasswordHash string, now time.Time) (UUID, error)
}
