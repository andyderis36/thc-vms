package gate_test

import (
	"errors"
	"testing"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/gate"
)

// TestCheckIn_AdminOnOwnBranchSucceeds pins R2 (masuk): koordinator cabang
// boleh mengeksekusi check-in seperti security, terbatas cabang sendiri, dan
// log mencatat checked_in_by = id admin.
func TestCheckIn_AdminOnOwnBranchSucceeds(t *testing.T) {
	t.Parallel()
	// Given: kunjungan approved dalam jendela pada cabang admin.
	start, end := openWindow()
	visit := visitFixture("visit-admin-in", domain.VisitStatusApproved, start, end)
	visits := newFakeVisitRepo(visit)
	checks := newFakeCheckInOutRepo()
	svc := checkInService(visits, checks)
	actor := gate.Actor{ID: "adm-1", Role: domain.RoleAdmin, LocationID: uuidPtr("loc-A")}
	// When: admin cabang mengeksekusi check-in.
	got, err := svc.CheckIn(t.Context(), actor, string(visit.ID), gate.CheckInInput{})
	// Then: sukses dan tercatat atas nama admin.
	if err != nil {
		t.Fatalf("expected admin check-in on own branch to succeed, got %v", err)
	}
	if got.CheckedInBy != actor.ID {
		t.Fatalf("expected checked-in by %q, got %q", actor.ID, got.CheckedInBy)
	}
	if visits.visits[visit.ID].Status != domain.VisitStatusVisiting {
		t.Fatalf("expected status visiting, got %q", visits.visits[visit.ID].Status)
	}
}

// TestCheckOut_AdminOnOwnBranchSucceeds pins R2 (keluar): admin cabang boleh
// mengeksekusi check-out seperti security, terbatas cabang sendiri, dan log
// mencatat checked_out_by = id admin.
func TestCheckOut_AdminOnOwnBranchSucceeds(t *testing.T) {
	t.Parallel()
	// Given: kunjungan visiting pada cabang admin (tanpa jendela waktu).
	start, end := openWindow()
	visit := visitFixture("visit-admin-out", domain.VisitStatusVisiting, start, end)
	visits := newFakeVisitRepo(visit)
	checks := newFakeCheckInOutRepo()
	svc := checkInService(visits, checks)
	actor := gate.Actor{ID: "adm-1", Role: domain.RoleAdmin, LocationID: uuidPtr("loc-A")}
	// When: admin cabang mengeksekusi check-out.
	got, err := svc.CheckOut(t.Context(), actor, visit.ID)
	// Then: sukses dan tercatat atas nama admin.
	if err != nil {
		t.Fatalf("expected admin check-out on own branch to succeed, got %v", err)
	}
	if got.CheckedOutBy != actor.ID {
		t.Fatalf("expected checked-out by %q, got %q", actor.ID, got.CheckedOutBy)
	}
	if visits.visits[visit.ID].Status != domain.VisitStatusCompleted {
		t.Fatalf("expected status completed, got %q", visits.visits[visit.ID].Status)
	}
}

// TestCheckOut_SuperAdminBypassesBranch pins R3 (keluar): super_admin tanpa
// lokasi boleh check-out lintas cabang dalam keadaan darurat, tercatat atas
// nama super_admin.
func TestCheckOut_SuperAdminBypassesBranch(t *testing.T) {
	t.Parallel()
	// Given: kunjungan visiting pada loc-B dipindai super_admin tanpa lokasi.
	start, end := openWindow()
	visit := visitFixture("visit-su-out", domain.VisitStatusVisiting, start, end)
	visit.LocationID = "loc-B"
	visits := newFakeVisitRepo(visit)
	checks := newFakeCheckInOutRepo()
	svc := checkInService(visits, checks)
	actor := gate.Actor{ID: "su-1", Role: domain.RoleSuperAdmin}
	// When: check-out darurat berjalan.
	got, err := svc.CheckOut(t.Context(), actor, visit.ID)
	// Then: bypass berlaku — check-out sukses.
	if err != nil {
		t.Fatalf("expected super_admin bypass to succeed, got %v", err)
	}
	if got.CheckedOutBy != actor.ID {
		t.Fatalf("expected checked-out by %q, got %q", actor.ID, got.CheckedOutBy)
	}
	if visits.visits[visit.ID].Status != domain.VisitStatusCompleted {
		t.Fatalf("expected status completed, got %q", visits.visits[visit.ID].Status)
	}
}

// TestCheckOut_SuperAdminStillBoundByState pins R3 bukan tanpa hukum: bypass
// hanya membuka kunci cabang; penjaga status tetap berlaku bahkan untuk
// super_admin.
func TestCheckOut_SuperAdminStillBoundByState(t *testing.T) {
	t.Parallel()
	// Given: kunjungan approved (belum visiting) pada cabang mana pun.
	start, end := openWindow()
	visit := visitFixture("visit-su-guard", domain.VisitStatusApproved, start, end)
	visit.LocationID = "loc-B"
	visits := newFakeVisitRepo(visit)
	checks := newFakeCheckInOutRepo()
	svc := checkInService(visits, checks)
	actor := gate.Actor{ID: "su-1", Role: domain.RoleSuperAdmin}
	// When: super_admin mencoba check-out di luar status visiting.
	_, err := svc.CheckOut(t.Context(), actor, visit.ID)
	// Then: konflik status, tanpa tulisan.
	if err == nil {
		t.Fatal("expected non-visiting check-out to be refused even for super_admin, got nil")
	}
	if !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("expected ErrConflict, got %v", err)
	}
	if len(visits.writes) != 0 || len(checks.checkOuts) != 0 {
		t.Fatalf("refused check-out must not write: %d status writes, %d check-outs",
			len(visits.writes), len(checks.checkOuts))
	}
}
