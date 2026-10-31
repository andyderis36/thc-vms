package superadmin

import (
	"fmt"

	"thc-vms/backend/internal/domain"
)

// CheckUserDelete guards DELETE /users/:id before any count or write: the
// target must exist (found=false renders 404 upstream), the caller must not
// delete its own account, and no super_admin row may be deleted by anyone
// (the self rule already refuses the actor's own row, so every other
// super_admin row is untouchable too). It mirrors CheckUserStatusChange so
// both account mutations share one refusal vocabulary.
func CheckUserDelete(actorID domain.UUID, found bool, target domain.ManagedUser) error {
	if !found {
		return domain.NotFoundEntity("Akun")
	}
	if target.User.ID == actorID {
		return forbidden("Tidak dapat menghapus akun sendiri.")
	}
	if domain.IsSuperAdminRole(target.Role) {
		return forbidden("Akun superadmin tidak dapat dihapus.")
	}
	return nil
}

// CheckUserReferences guards DELETE /users/:id after the identity guard: a
// vendor that still owns visits, or a staff account that still wrote gate or
// audit rows, refuses with 409 and a message naming the blocker. The counts
// come from the repository pre-checks; the database FK (23503 -> 409 via
// MapError) is the second line of defence for a reference that races the
// check.
func CheckUserReferences(visitsByVendorUser, staffReferences int64) error {
	if visitsByVendorUser > 0 {
		return domain.Conflict(fmt.Sprintf(
			"Akun masih memiliki %d kunjungan sebagai vendor dan tidak dapat dihapus. Hapus atau alihkan kunjungan tersebut terlebih dahulu.", visitsByVendorUser))
	}
	if staffReferences > 0 {
		return domain.Conflict(fmt.Sprintf(
			"Akun masih tercatat pada %d riwayat operasional (check-in, check-out, atau status) dan tidak dapat dihapus.", staffReferences))
	}
	return nil
}

// CheckLocationReferences guards DELETE /locations/:id: a facility that
// still stations users or hosts visits refuses with 409 naming the blocker.
// The counts come from the repository pre-checks; the database FKs
// (23503 -> 409 via MapError) are the second line of defence.
func CheckLocationReferences(users, visits int64) error {
	if users > 0 {
		return domain.Conflict(fmt.Sprintf(
			"Fasilitas masih memiliki %d pengguna terdaftar dan tidak dapat dihapus. Pindahkan atau hapus pengguna tersebut terlebih dahulu.", users))
	}
	if visits > 0 {
		return domain.Conflict(fmt.Sprintf(
			"Fasilitas masih memiliki %d kunjungan dan tidak dapat dihapus. Hapus kunjungan tersebut terlebih dahulu.", visits))
	}
	return nil
}
