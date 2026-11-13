package domain_test

import (
	"testing"

	"thc-vms/backend/internal/domain"
)

// TestSplitOverseerBcc_DevGoesToBcc membuktikan alamat dev-superadmin yang
// tersembunyi dipindah ke Bcc sementara penerima langsung bertahan di To:
// kesamaan huruf besar/kecil dan spasi diabaikan, alamat kosong dibuang.
func TestSplitOverseerBcc_DevGoesToBcc(t *testing.T) {
	to, bcc := domain.SplitOverseerBcc([]string{
		"superadmin@thc.local",
		"  DEV-SUPERADMIN@transhybrid.net.id  ",
		"",
		"   ",
		"admin-cabang@thc.local",
	})
	if len(to) != 2 || to[0] != "superadmin@thc.local" || to[1] != "admin-cabang@thc.local" {
		t.Fatalf("to = %v, want the two direct owners trimmed", to)
	}
	if len(bcc) != 1 || bcc[0] != "DEV-SUPERADMIN@transhybrid.net.id" {
		t.Fatalf("bcc = %v, want exactly the dev address trimmed", bcc)
	}
}

// TestSplitOverseerBcc_NoDevMeansEmptyBcc membuktikan daftar tanpa alamat
// dev menghasilkan Bcc kosong (bukan nil yang bocor ke pemanggil sebagai
// kiriman): tidak ada yang disembunyikan bila tidak ada overseer.
func TestSplitOverseerBcc_NoDevMeansEmptyBcc(t *testing.T) {
	to, bcc := domain.SplitOverseerBcc([]string{"a@thc.local", "b@thc.local"})
	if len(to) != 2 {
		t.Fatalf("to = %v, want both addresses", to)
	}
	if len(bcc) != 0 {
		t.Fatalf("bcc = %v, want empty", bcc)
	}
}

// TestSplitOverseerBcc_EmptyInputStaysEmpty membuktikan masukan kosong atau
// blank menghasilkan kedua sisi kosong sehingga pemanggil melewatkan send
// persis seperti To kosong.
func TestSplitOverseerBcc_EmptyInputStaysEmpty(t *testing.T) {
	for _, in := range [][]string{nil, {}, {"", "   "}} {
		to, bcc := domain.SplitOverseerBcc(in)
		if len(to) != 0 || len(bcc) != 0 {
			t.Fatalf("in = %v: to = %v bcc = %v, want both empty", in, to, bcc)
		}
	}
}
