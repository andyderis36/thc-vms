package validation

import (
	"errors"
	"net/mail"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// manualVisitIDPattern is the marker vocabulary a scanner may resolve by hand:
// alphanumerics, dashes (VST-...) and underscores (UUIDs).
const manualVisitIDPattern = `^[A-Za-z0-9_-]+$`

var (
	idNumberRe      = regexp.MustCompile(IDNumberPattern)
	phoneRe         = regexp.MustCompile(PhonePattern)
	manualVisitIDRe = regexp.MustCompile(manualVisitIDPattern)
)

// Password validation failures. Callers only need non-nil, but keeping them
// as sentinels lets a later wave render field-specific messages.
var (
	errPasswordTooShort = errors.New("Kata sandi minimal 8 karakter.")
	errPasswordTooLong  = errors.New("Kata sandi terlalu panjang (maksimal 72 byte).")
)

// RuneLen counts characters, not bytes, so a multi-byte name is measured the
// way a user sees it.
func RuneLen(s string) int {
	return utf8.RuneCountInString(s)
}

// NormalizePhone canonicalises an Indonesian phone number: trim, drop every
// non-digit rune, then replace a leading 62 country code with a leading 0.
// "+62 812-3456-7890" therefore becomes "081234567890".
func NormalizePhone(raw string) string {
	var digits strings.Builder
	digits.Grow(len(raw))
	for _, r := range strings.TrimSpace(raw) {
		if r >= '0' && r <= '9' {
			digits.WriteRune(r)
		}
	}
	normalized := digits.String()
	if strings.HasPrefix(normalized, "62") {
		return "0" + normalized[2:]
	}
	return normalized
}

// ValidPhone reports whether raw is an Indonesian phone number. The
// normalized form must match PhonePattern and stay within PhoneMaxLength.
func ValidPhone(raw string) bool {
	normalized := NormalizePhone(raw)
	return RuneLen(normalized) <= PhoneMaxLength && phoneRe.MatchString(normalized)
}

// ValidIDNumber reports whether the trimmed identity-document number matches
// IDNumberPattern.
func ValidIDNumber(raw string) bool {
	return idNumberRe.MatchString(strings.TrimSpace(raw))
}

// ValidEmail reports whether the trimmed address is a plain mailbox: within
// EmailMaxLength, parseable by net/mail, and exactly the address it parsed to.
// Display-name forms such as "A <a@b.co>" are rejected because the parsed
// address differs from the input.
func ValidEmail(raw string) bool {
	email := strings.TrimSpace(raw)
	if email == "" || RuneLen(email) > EmailMaxLength {
		return false
	}
	addr, err := mail.ParseAddress(email)
	if err != nil {
		return false
	}
	return addr.Address == email
}

// ValidPassword enforces the password policy: at least PasswordMinLength runes
// and at most PasswordMaxBytes bytes, bcrypt's hard ceiling. The error message
// is shown to the user, so it is Bahasa Indonesia.
func ValidPassword(pw string) error {
	if RuneLen(pw) < PasswordMinLength {
		return errPasswordTooShort
	}
	if len(pw) > PasswordMaxBytes {
		return errPasswordTooLong
	}
	return nil
}

// ValidManualVisitID reports whether raw can be typed into the manual scanner
// fallback: trimmed, 1..VisitIDInputMaxLength runes, no whitespace, and only
// letters, digits, dashes or underscores.
func ValidManualVisitID(raw string) bool {
	id := strings.TrimSpace(raw)
	length := RuneLen(id)
	if length == 0 || length > VisitIDInputMaxLength {
		return false
	}
	if strings.IndexFunc(id, unicode.IsSpace) >= 0 {
		return false
	}
	return manualVisitIDRe.MatchString(id)
}
