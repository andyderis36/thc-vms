// Package drain menuntaskan sisa body request yang tidak terbaca.
package drain

import "io"

// Bounded membaca hingga limit byte dari r lalu membuangnya, dan melaporkan
// berapa byte yang tertelan. Dipakai sebelum menulis respons 413: bila body
// masih tersisa di soket, server Go menutup koneksi dengan RST sehingga klien
// bisa kehilangan status 413 yang sudah ditulis (lihat I-05). Batas atas
// menjaga agar body raksasa tidak dibaca tanpa henti.
func Bounded(r io.Reader, limit int64) int64 {
	if r == nil || limit <= 0 {
		return 0
	}
	n, _ := io.CopyN(io.Discard, r, limit)
	return n
}
