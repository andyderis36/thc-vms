package visit

import (
	"context"
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

type VisitorInput struct {
	Name     string
	IDNumber string
	Phone    string
	// IDCardPhotoURL is the MinIO/S3 URL of the technician's KTP/SIM photo,
	// uploaded beforehand through POST /uploads with the id_card category.
	IDCardPhotoURL *string
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
	// AssignmentLetterURL is the MinIO/S3 URL of the vendor's Surat Tugas /
	// SPK, uploaded beforehand through POST /uploads with the
	// assignment_letter category. Optional, per the openapi schema.
	AssignmentLetterURL *string
}

// CreateVisit files a new visit request in status requested. Field validation
// runs in a fixed order before any scope check and before any repository call.
func (s *Service) CreateVisit(ctx context.Context, actor Actor, in CreateVisitInput) (domain.VisitRequest, error) {
	if strings.TrimSpace(string(in.LocationID)) == "" {
		return domain.VisitRequest{}, domain.ValidationFailure("Lokasi kunjungan wajib diisi.")
	}
	if len(in.PurposeIDs) < 1 {
		return domain.VisitRequest{}, domain.ValidationFailure("Minimal satu tujuan kunjungan wajib dipilih.")
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
		if err := validateVisitor(visitor, i+1); err != nil {
			return domain.VisitRequest{}, err
		}
	}

	// Scope: a PIC may request any destination; an admin only its own branch.
	// Security staff file no requests: their post is the gate, not the form.
	if err := actor.requireRole(domain.RolePIC, domain.RoleAdmin, domain.RoleSuperAdmin); err != nil {
		return domain.VisitRequest{}, err
	}
	if actor.Role == domain.RoleAdmin {
		if err := actor.requireBranch(in.LocationID); err != nil {
			return domain.VisitRequest{}, err
		}
	}

	visit := domain.VisitRequest{
		PICUserID:     actor.ID,
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
		visitors = append(visitors, visitor)
	}
	return s.visits.Create(ctx, visit, visitors, in.PurposeIDs)
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

func validateVisitor(v VisitorInput, n int) error {
	if strings.TrimSpace(v.Name) == "" {
		return domain.ValidationFailure("Nama pengunjung ke-" + itoa(n) + " wajib diisi.")
	}
	if strings.TrimSpace(v.IDNumber) == "" {
		return domain.ValidationFailure("Nomor identitas pengunjung ke-" + itoa(n) + " wajib diisi.")
	}
	if strings.TrimSpace(v.Phone) == "" {
		return domain.ValidationFailure("Nomor telepon pengunjung ke-" + itoa(n) + " wajib diisi.")
	}
	return nil
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
