package visit

import (
	"context"
	"testing"

	"thc-vms/backend/internal/domain"
)

// TestCreateVisit_ConcurrentOverlappingVisitsBothAccepted pins R1: satu akun
// vendor boleh mengajukan kunjungan baru berhimpitan jadwal selagi kunjungan
// sebelumnya belum selesai. Tidak ada penolakan sistem; penilaian duplikat
// tetap keputusan manusia pada tahap approval (admin boleh menolak).
func TestCreateVisit_ConcurrentOverlappingVisitsBothAccepted(t *testing.T) {
	repo := newFakeVisitRepo(t)
	svc := newTestService(repo, nil, testNow())
	actor := testActor(domain.RoleVendor, "pic-1", "")

	first := validCreateInput()
	second := validCreateInput()

	if _, err := svc.CreateVisit(context.Background(), actor, first); err != nil {
		t.Fatalf("kunjungan pertama harus diterima, got: %v", err)
	}
	if _, err := svc.CreateVisit(context.Background(), actor, second); err != nil {
		t.Fatalf("kunjungan kedua berhimpitan jadwal harus tetap diterima, got: %v", err)
	}
	if repo.createCalls != 2 {
		t.Fatalf("createCalls = %d, want 2 (kedua kunjungan tersimpan)", repo.createCalls)
	}
}
