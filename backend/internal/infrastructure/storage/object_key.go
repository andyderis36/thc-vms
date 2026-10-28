package storage

import (
	"fmt"
	"path"
	"strings"
)

// Upload categories, exactly the four tokens the openapi /uploads multipart
// contract accepts. The token itself never reaches an object key: each maps to
// the plural directory mandated by AGENTS.md 6.4, so a caller cannot smuggle a
// directory of its own choosing into the bucket.
const (
	CategoryAssignmentLetter = "assignment_letter"
	CategoryIDCard           = "id_card"
	CategoryCheckinPhoto     = "checkin_photo"
	CategoryProfilePhoto     = "profile_photo"
)

// rejectKey is the sentinel a sanitisation test compares against to mean "this
// input must be refused", as opposed to "this input must be rewritten".
const rejectKey = ""

// Bounds on the two caller-controlled key segments. They exist so a legal but
// hostile name cannot produce an unbounded object key.
const (
	maxFileNameLength = 128
	maxOwnerIDLength  = 64
)

// categoryDirectories maps the openapi category token onto its object-key
// directory. A category absent from this map has no directory, which is why
// buildObjectKey refuses it instead of inventing one.
var categoryDirectories = map[string]string{
	CategoryAssignmentLetter: "assignment_letters",
	CategoryIDCard:           "id_cards",
	CategoryCheckinPhoto:     "checkin_photos",
	CategoryProfilePhoto:     "profile_photos",
}

// buildObjectKey assembles "<directory>/<ownerID>/<fileName>" for one upload.
//
// Every segment is validated rather than escaped: an unknown category, an owner
// id carrying a path separator, and a name that reduces to a traversal segment
// are all refused with domain.ErrStorageRejected. A name that merely contains
// directory components is reduced to its last segment instead, so an ordinary
// "a/b/report.pdf" is stored rather than rejected.
func buildObjectKey(category, ownerID, fileName string) (string, error) {
	directory, known := categoryDirectories[category]
	if !known {
		return "", reject(fmt.Sprintf("kategori berkas tidak dikenal: %q", category))
	}
	if err := validateOwnerID(ownerID); err != nil {
		return "", err
	}
	safeName, err := sanitiseFileName(fileName)
	if err != nil {
		return "", err
	}
	return directory + "/" + ownerID + "/" + safeName, nil
}

// validateOwnerID accepts only the identifier shape the callers actually use: a
// uuid (visit or visitor id) or a VST- business code. Letters, digits, dash,
// underscore and dot are permitted; a separator, a space, a traversal or an
// over-long value is refused, because the owner id is a whole path segment and
// must never be able to introduce one of its own.
func validateOwnerID(ownerID string) error {
	if ownerID == "" {
		return reject("kategori berkas tanpa id pemilik")
	}
	if len(ownerID) > maxOwnerIDLength {
		return reject(fmt.Sprintf("id pemilik berkas terlalu panjang: %d karakter", len(ownerID)))
	}
	if ownerID == ".." || strings.Contains(ownerID, "..") {
		return reject(fmt.Sprintf("id pemilik berkas tidak valid: %q", ownerID))
	}
	for _, r := range ownerID {
		switch {
		case r >= 'a' && r <= 'z',
			r >= 'A' && r <= 'Z',
			r >= '0' && r <= '9',
			r == '-', r == '_', r == '.':
		default:
			return reject(fmt.Sprintf("id pemilik berkas tidak valid: %q", ownerID))
		}
	}
	return nil
}

// sanitiseFileName reduces a client-supplied name to a single safe path
// segment. It strips every directory component (both separators, because a
// Windows client sends backslashes), refuses a name that reduces to nothing or
// to a traversal segment, and caps the length while preserving the extension so
// a truncated name is still recognisable to an operator.
func sanitiseFileName(fileName string) (string, error) {
	trimmed := strings.TrimSpace(fileName)
	if trimmed == "" {
		return "", reject("nama berkas kosong")
	}
	// Normalise Windows separators so path.Base sees one separator style.
	normalised := strings.ReplaceAll(trimmed, `\`, "/")
	base := path.Base(normalised)
	if base == "." || base == "/" || base == ".." || strings.TrimSpace(base) == "" {
		return "", reject(fmt.Sprintf("nama berkas tidak valid: %q", fileName))
	}
	return truncateKeepingExtension(base), nil
}

// truncateKeepingExtension caps name at maxFileNameLength characters. The
// extension is preserved so the stored object stays identifiable, and a name
// that is already short enough is returned untouched.
func truncateKeepingExtension(name string) string {
	if len(name) <= maxFileNameLength {
		return name
	}
	extension := path.Ext(name)
	if len(extension) >= maxFileNameLength {
		// A pathological "extension" that is the whole name: keep its tail.
		return name[len(name)-maxFileNameLength:]
	}
	keep := maxFileNameLength - len(extension)
	return name[:keep] + extension
}

// splitObjectKeyHint reads the "category/ownerID" hint a caller places in
// UploadRequest.ObjectKey and returns the two segments verbatim. The hint is the
// only place the category and the owning id enter the adapter; the adapter then
// rebuilds the key itself, so a caller cannot dictate the directory layout.
func splitObjectKeyHint(hint string) (category, ownerID string, err error) {
	parts := strings.Split(hint, "/")
	if len(parts) != 2 {
		return "", "", reject(fmt.Sprintf("object key harus berformat category/ownerID, got %q", hint))
	}
	category, ownerID = parts[0], parts[1]
	if category == "" || ownerID == "" {
		return "", "", reject(fmt.Sprintf("object key harus berformat category/ownerID, got %q", hint))
	}
	return category, ownerID, nil
}
