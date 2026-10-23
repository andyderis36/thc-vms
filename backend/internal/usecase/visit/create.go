package visit

import (
	"context"
	"net"
	"net/url"
	"strings"
	"time"

	"thc-vms/backend/internal/domain"
)

// VisitorInput is one technician travelling under a visit request.
// textOrEmpty dereferences an optional uploaded-file URL, mapping the absent
// case to the empty string so callers can trim-and-test in one step.
func textOrEmpty(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// Manual-input length caps (migration 000005): a rune count on the trimmed
// value, so multi-byte company names are measured as the user sees them.
const (
	maxManualVendorNameLen = 120
	maxPurposeNoteLen      = 200
	maxJabatanLen          = 120
)

type VisitorInput struct {
	Name     string
	IDNumber string
	Phone    string
	// IDCardPhotoURL is the MinIO/S3 URL of the technician's KTP/SIM photo,
	// uploaded beforehand through POST /uploads with the id_card category.
	IDCardPhotoURL *string
	// PhotoURL is the MinIO/S3 URL of the technician's selfie, uploaded
	// beforehand through POST /uploads with the same id_card category (no new
	// storage category: YAGNI). Optional, per the openapi schema.
	PhotoURL *string
	// VendorID is the technician's own company. Optional: internal staff
	// travel without one. When set it must name an active (not blacklisted)
	// vendor from the catalogue.
	VendorID *domain.UUID
	// VendorName is the manually typed company (migration 000005), honoured
	// ONLY when VendorID is absent: a sent VendorID wins and this text is
	// discarded, never stored alongside it. It never enters the vendor
	// catalogue, so the dropdown keeps showing registered vendors only.
	VendorName *string
	// Jabatan is the optional free-text position of this visiting member
	// (migration 000012), e.g. "Teknisi", "Mandor", "Supervisor". It is
	// trimmed and capped; a blank input becomes absent (NULL). It is NEVER a
	// catalogue lookup: values typed earlier are suggestions only.
	Jabatan *string
}

// CreateVisitInput is the data needed to file a new visit request.
type CreateVisitInput struct {
	LocationID    domain.UUID
	PurposeIDs    []domain.UUID
	Visitors      []VisitorInput
	StartDate     time.Time
	EndDate       time.Time
	IsNDAAccepted bool
	Notes         string
	// PurposeNote is the free-typed "tujuan lain" (migration 000005). Either
	// a non-empty PurposeIDs or a non-empty PurposeNote is required; both may
	// travel together. It never enters the purpose catalogue.
	PurposeNote string
	// AssignmentLetterURL is the MinIO/S3 URL of the vendor's Surat Tugas /
	// SPK, uploaded beforehand through POST /uploads with the
	// assignment_letter category. Mandatory for new requests; data filed
	// before this rule is grandfathered (no check on read/update paths).
	AssignmentLetterURL *string
}

// CreateVisit files a new visit request in status requested. Field validation
// runs in a fixed order before any scope check and before any repository call.
func (s *Service) CreateVisit(ctx context.Context, actor Actor, in CreateVisitInput) (domain.VisitRequest, error) {
	if strings.TrimSpace(string(in.LocationID)) == "" {
		return domain.VisitRequest{}, domain.ValidationFailure("Lokasi kunjungan wajib diisi.")
	}
	if len(in.PurposeIDs) < 1 && strings.TrimSpace(in.PurposeNote) == "" {
		return domain.VisitRequest{}, domain.ValidationFailure("Minimal satu tujuan kunjungan wajib dipilih atau ditulis.")
	}
	if len([]rune(strings.TrimSpace(in.PurposeNote))) > maxPurposeNoteLen {
		return domain.VisitRequest{}, domain.ValidationFailure("Tujuan lain kunjungan maksimal 200 karakter.")
	}
	if len(in.Visitors) < 1 {
		return domain.VisitRequest{}, domain.ValidationFailure("Minimal satu pengunjung wajib didaftarkan.")
	}
	if len(in.Visitors) > 10 {
		return domain.VisitRequest{}, domain.ValidationFailure("Jumlah pengunjung maksimal 10 orang.")
	}
	if err := validateWindow(in.StartDate, in.EndDate); err != nil {
		return domain.VisitRequest{}, err
	}
	if !in.IsNDAAccepted {
		return domain.VisitRequest{}, domain.ValidationFailure("Persetujuan NDA wajib disetujui sebagai bentuk kepatuhan K3/SOP sebelum mengajukan kunjungan.")
	}
	for i, visitor := range in.Visitors {
		if err := validateVisitor(visitor, i+1, s.trustedFileOrigins); err != nil {
			return domain.VisitRequest{}, err
		}
	}
	// AssignmentLetterURL is mandatory for NEW requests only; grandfathered
	// rows without one keep flowing through get/list/update/reschedule
	// untouched (no check exists on those paths).
	if strings.TrimSpace(textOrEmpty(in.AssignmentLetterURL)) == "" {
		return domain.VisitRequest{}, domain.ValidationFailure("Surat Tugas / SPK wajib diunggah.")
	}
	if err := s.validatePhotoURL(textOrEmpty(in.AssignmentLetterURL)); err != nil {
		return domain.VisitRequest{}, err
	}

	// Scope: a vendor may request any destination; an admin only its own branch.
	// Security staff file no requests: their post is the gate, not the form.
	if err := actor.requireRole(domain.RoleVendor, domain.RoleAdmin, domain.RoleSuperAdmin); err != nil {
		return domain.VisitRequest{}, err
	}
	if actor.Role == domain.RoleAdmin {
		if err := actor.requireBranch(in.LocationID); err != nil {
			return domain.VisitRequest{}, err
		}
	}

	// Vendor: absent means internal staff. A named vendor must be an active
	// (non-blacklisted) catalogue row; ListVendors only returns active rows,
	// so membership is the existence+active check in one call. Each
	// technician carries its own company, so the check runs per visitor.
	// Free-choice vendor intent: any active catalogue vendor is accepted for
	// any actor (vendor, admin, super_admin alike); vendor-locking of the vendor to
	// the requesting account is deliberately not enforced.
	vendorNames := map[domain.UUID]string{}
	if s.vendors != nil {
		vendors, err := s.vendors.ListVendors(ctx)
		if err != nil {
			return domain.VisitRequest{}, err
		}
		for _, v := range vendors {
			vendorNames[v.ID] = v.Name
		}
		for _, visitor := range in.Visitors {
			if visitor.VendorID == nil {
				continue
			}
			id := domain.UUID(strings.TrimSpace(string(*visitor.VendorID)))
			if id == "" {
				continue
			}
			if _, known := vendorNames[id]; !known {
				return domain.VisitRequest{}, domain.ValidationFailure("Vendor tidak ditemukan atau tidak aktif.")
			}
		}
	}

	visit := domain.VisitRequest{
		VendorUserID:  actor.ID,
		LocationID:    in.LocationID,
		StartDate:     in.StartDate,
		EndDate:       in.EndDate,
		IsMultiDay:    !sameCalendarDay(in.StartDate, in.EndDate),
		Status:        domain.VisitStatusRequested,
		IsNDAAccepted: true,
	}
	if letter := strings.TrimSpace(textOrEmpty(in.AssignmentLetterURL)); letter != "" {
		visit.AssignmentLetterURL = &letter
	}
	if notes := strings.TrimSpace(in.Notes); notes != "" {
		visit.Notes = &notes
	}
	if note := strings.TrimSpace(in.PurposeNote); note != "" {
		visit.PurposeNote = &note
	}
	visitors := make([]domain.Visitor, 0, len(in.Visitors))
	for _, v := range in.Visitors {
		visitor := domain.Visitor{
			Name:     strings.TrimSpace(v.Name),
			IDNumber: strings.TrimSpace(v.IDNumber),
			Phone:    strings.TrimSpace(v.Phone),
		}
		if photo := strings.TrimSpace(textOrEmpty(v.IDCardPhotoURL)); photo != "" {
			visitor.IDCardPhotoURL = &photo
		}
		if selfie := strings.TrimSpace(textOrEmpty(v.PhotoURL)); selfie != "" {
			visitor.PhotoURL = &selfie
		}
		// Catalogue wins: a valid VendorID resolves the display name and the
		// manual text is discarded (never stored alongside it, so the read
		// helper's override-otherwise-catalogue stays unambiguous). The
		// manual name is stored only when no catalogue link travels along.
		if v.VendorID != nil {
			if id := domain.UUID(strings.TrimSpace(string(*v.VendorID))); id != "" {
				visitor.VendorID = id
				visitor.VendorName = vendorNames[id]
			}
		} else if name := strings.TrimSpace(textOrEmpty(v.VendorName)); name != "" {
			visitor.VendorNameOverride = &name
			visitor.VendorName = name
		}
		if jabatan := strings.TrimSpace(textOrEmpty(v.Jabatan)); jabatan != "" {
			visitor.Jabatan = &jabatan
		}
		visitors = append(visitors, visitor)
	}
	created, err := s.visits.Create(ctx, visit, visitors, in.PurposeIDs)
	if err != nil {
		return domain.VisitRequest{}, err
	}
	// The repository returns the visit row without its roster, so the
	// just-validated roster (with resolved vendor names) travels back on the
	// created visit for the response echo.
	created.Visitors = visitors
	return created, nil
}

// validateWindow enforces that both schedule bounds are present and that the
// end is strictly after the start. It is shared by create and reschedule so
// both edges speak the same messages.
func validateWindow(start time.Time, end time.Time) error {
	if start.IsZero() {
		return domain.ValidationFailure("Tanggal mulai kunjungan wajib diisi.")
	}
	if end.IsZero() {
		return domain.ValidationFailure("Tanggal selesai kunjungan wajib diisi.")
	}
	if !end.After(start) {
		return domain.ValidationFailure("Tanggal selesai harus setelah tanggal mulai.")
	}
	return nil
}

func validateVisitor(v VisitorInput, n int, allow FileOriginAllowlist) error {
	if strings.TrimSpace(v.Name) == "" {
		return domain.ValidationFailure("Nama pengunjung ke-" + itoa(n) + " wajib diisi.")
	}
	if strings.TrimSpace(v.IDNumber) == "" {
		return domain.ValidationFailure("Nomor identitas pengunjung ke-" + itoa(n) + " wajib diisi.")
	}
	if strings.TrimSpace(v.Phone) == "" {
		return domain.ValidationFailure("Nomor telepon pengunjung ke-" + itoa(n) + " wajib diisi.")
	}
	if err := validatePhotoURL(textOrEmpty(v.IDCardPhotoURL), allow); err != nil {
		return err
	}
	if err := validatePhotoURL(textOrEmpty(v.PhotoURL), allow); err != nil {
		return err
	}
	if len([]rune(strings.TrimSpace(textOrEmpty(v.VendorName)))) > maxManualVendorNameLen {
		return domain.ValidationFailure("Nama perusahaan vendor pengunjung ke-" + itoa(n) + " maksimal 120 karakter.")
	}
	if len([]rune(strings.TrimSpace(textOrEmpty(v.Jabatan)))) > maxJabatanLen {
		return domain.ValidationFailure("Jabatan pengunjung ke-" + itoa(n) + " maksimal 120 karakter.")
	}
	return nil
}

// FileOriginAllowlist holds the hosts whose plain-HTTP file URLs the app
// accepts. It is derived from the deployment's own object-storage origins
// (S3_PUBLIC_BASE_URL / S3_ENDPOINT), so the URLs the storage adapter itself
// hands out are always accepted — including a LAN-IP deployment that serves
// objects over plain HTTP because it has no TLS certificate. Everything else
// keeps the strict rule: https for any host, http only for the dev hosts.
type FileOriginAllowlist map[string]struct{}

// NewFileOriginAllowlist builds the allowlist from raw origins. A full URL
// contributes its hostname; a bare host or host:port contributes its host
// part (the S3 endpoint is often configured without a scheme). Blank or
// unparsable entries are skipped.
func NewFileOriginAllowlist(rawOrigins ...string) FileOriginAllowlist {
	allow := FileOriginAllowlist{}
	for _, raw := range rawOrigins {
		host := hostFromOrigin(raw)
		if host == "" {
			continue
		}
		allow[host] = struct{}{}
	}
	return allow
}

// hostFromOrigin extracts the lowercase hostname of an origin that may be a
// full URL, a host, or a host:port pair.
func hostFromOrigin(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	if !strings.Contains(trimmed, "://") {
		if host, _, err := net.SplitHostPort(trimmed); err == nil {
			return strings.ToLower(host)
		}
		return strings.ToLower(trimmed)
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return ""
	}
	return strings.ToLower(parsed.Hostname())
}

// ValidatePhotoURL is the central allowlist for every uploaded-file URL that
// travels through a visit payload (visitor id_card_photo_url, visitor
// photo_url selfie, assignment_letter_url) and the gate check-in photo_url.
// Empty (absent) is allowed; a non-empty value must be an https URL, or an
// http URL only for the dev MinIO hosts (localhost/127.0.0.1) and for the
// deployment's own configured object-storage hosts, at most 2048 characters,
// and never a javascript:/data:/blob:/vbscript: payload. It lives in package
// visit so the gate usecase reuses the same gate.
func ValidatePhotoURL(raw string, allow FileOriginAllowlist) error {
	return validatePhotoURL(raw, allow)
}

func validatePhotoURL(raw string, allow FileOriginAllowlist) error {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil
	}
	if len(trimmed) > 2048 {
		return domain.ValidationFailure("Tautan berkas tidak valid: terlalu panjang.")
	}
	lower := strings.ToLower(trimmed)
	for _, bad := range []string{"javascript:", "data:", "blob:", "vbscript:"} {
		if strings.HasPrefix(lower, bad) {
			return domain.ValidationFailure("Tautan berkas tidak valid.")
		}
	}
	u, err := url.Parse(trimmed)
	if err != nil {
		return domain.ValidationFailure("Tautan berkas tidak valid.")
	}
	switch strings.ToLower(u.Scheme) {
	case "https":
		if u.Hostname() == "" {
			return domain.ValidationFailure("Tautan berkas tidak valid.")
		}
		return nil
	case "http":
		hostname := strings.ToLower(u.Hostname())
		switch hostname {
		case "localhost", "127.0.0.1":
			return nil
		default:
			if _, trusted := allow[hostname]; trusted {
				return nil
			}
			return domain.ValidationFailure("Tautan berkas tidak valid: http hanya diizinkan untuk localhost atau host object storage yang dikonfigurasi.")
		}
	default:
		return domain.ValidationFailure("Tautan berkas tidak valid.")
	}
}

func sameCalendarDay(a time.Time, b time.Time) bool {
	ay, am, ad := a.UTC().Date()
	by, bm, bd := b.UTC().Date()
	return ay == by && am == bm && ad == bd
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var digits []byte
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}
