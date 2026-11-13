package domain_test

import (
	"testing"

	"thc-vms/backend/internal/domain"
)

// TestParseMailLogStatus_StatusVocabulary membuktikan ?status= hanya menerima
// tiga verdict (kosong berarti tanpa filter); nilai asing ditolak agar tak
// pernah menyempitkan/memperlebar listing secara diam-diam.
func TestParseMailLogStatus_StatusVocabulary(t *testing.T) {
	cases := []struct {
		raw   string
		want  domain.MailLogStatus
		valid bool
	}{
		{"", "", true},
		{"queued", domain.MailLogQueued, true},
		{"sent", domain.MailLogSent, true},
		{"failed", domain.MailLogFailed, true},
		{"SENT", "", false},
		{"dropped", "", false},
		{"queued,sent", "", false},
	}
	for _, tc := range cases {
		got, ok := domain.ParseMailLogStatus(tc.raw)
		if ok != tc.valid || got != tc.want {
			t.Fatalf("ParseMailLogStatus(%q) = (%q, %v), want (%q, %v)", tc.raw, got, ok, tc.want, tc.valid)
		}
	}
}

// TestNormaliseMailLogFilter_PaginationContract membuktikan kontrak
// notifikasi (default 20, maks 100): limit kosong/negatif ke default, limit
// raksasa dipangkas, page nol/negatif ke 1.
func TestNormaliseMailLogFilter_PaginationContract(t *testing.T) {
	def := domain.NormaliseMailLogFilter(domain.MailLogFilter{})
	if def.Page != 1 || def.Limit != domain.DefaultMailLogPageSize {
		t.Fatalf("default = page %d limit %d, want 1/%d", def.Page, def.Limit, domain.DefaultMailLogPageSize)
	}
	huge := domain.NormaliseMailLogFilter(domain.MailLogFilter{Page: -3, Limit: 5000})
	if huge.Page != 1 || huge.Limit != domain.MaxMailLogPageSize {
		t.Fatalf("clamped = page %d limit %d, want 1/%d", huge.Page, huge.Limit, domain.MaxMailLogPageSize)
	}
	kept := domain.NormaliseMailLogFilter(domain.MailLogFilter{Page: 2, Limit: 20})
	if kept.Page != 2 || kept.Limit != 20 {
		t.Fatalf("kept = page %d limit %d, want 2/20", kept.Page, kept.Limit)
	}
}
