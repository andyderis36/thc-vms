package migrations

import (
	"testing"
)

// TestMaxVersion_PinsEmbeddedMaximum membuktikan MaxVersion membaca versi
// tertinggi dari nama berkas *.up.sql yang ter-embed. Angka ini WAJIB ikut
// bergerak setiap migrasi baru ditambahkan (inilah repoVersion milik
// GET /settings/system).
func TestMaxVersion_PinsEmbeddedMaximum(t *testing.T) {
	if got := MaxVersion(); got != 31 {
		t.Fatalf("MaxVersion() = %d, want 31 (perbarui test ini bersama migrasi baru)", got)
	}
	if again := MaxVersion(); again != MaxVersion() {
		t.Fatalf("MaxVersion() tidak stabil: %d vs %d", again, MaxVersion())
	}
}
