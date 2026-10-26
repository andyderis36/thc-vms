package imagecompress

import (
	"encoding/binary"
	"testing"
)

func TestJPEGOrientation(t *testing.T) {
	tests := []struct {
		name string
		src  []byte
		want int
		ok   bool
	}{
		{
			name: "little endian orientation 1",
			src:  jpegWithEXIF(binary.LittleEndian, 1),
			want: 1,
			ok:   true,
		},
		{
			name: "big endian orientation 6",
			src:  jpegWithEXIF(binary.BigEndian, 6),
			want: 6,
			ok:   true,
		},
		{
			name: "orientation 8",
			src:  jpegWithEXIF(binary.LittleEndian, 8),
			want: 8,
			ok:   true,
		},
		{
			name: "out of range orientation is ignored",
			src:  jpegWithEXIF(binary.LittleEndian, 9),
			want: 0,
			ok:   false,
		},
		{
			name: "no APP1 segment",
			src:  []byte{0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x02, 0xFF, 0xD9},
			want: 0,
			ok:   false,
		},
		{
			name: "not a JPEG",
			src:  []byte("this is not an image"),
			want: 0,
			ok:   false,
		},
		{
			name: "truncated APP1 length",
			src:  []byte{0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x40, 'E', 'x'},
			want: 0,
			ok:   false,
		},
		{
			name: "APP1 without EXIF signature",
			src:  append([]byte{0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x08}, []byte("JFIF\x00\x01\x01")...),
			want: 0,
			ok:   false,
		},
		{
			name: "EXIF with corrupt TIFF magic",
			src: func() []byte {
				app1 := exifAPP1(binary.LittleEndian, 6)
				app1[12] = 0x00 // TIFF magic no longer 42
				return append([]byte{0xFF, 0xD8}, append(app1, 0xFF, 0xD9)...)
			}(),
			want: 0,
			ok:   false,
		},
		{
			name: "EXIF with truncated IFD",
			src: func() []byte {
				app1 := exifAPP1(binary.LittleEndian, 6)
				truncated := append([]byte{0xFF, 0xD8}, app1[:len(app1)-20]...)
				return append(truncated, 0xFF, 0xD9)
			}(),
			want: 0,
			ok:   false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := jpegOrientation(tt.src)
			if got != tt.want || ok != tt.ok {
				t.Fatalf("jpegOrientation() = (%d, %v), want (%d, %v)", got, ok, tt.want, tt.ok)
			}
		})
	}
}

// jpegWithEXIF builds a marker-only JPEG carrying one APP1 EXIF block. The
// parser never needs pixel data, so the SOS marker is enough to stop the walk.
func jpegWithEXIF(order binary.ByteOrder, orientation uint16) []byte {
	out := []byte{0xFF, 0xD8}
	out = append(out, exifAPP1(order, orientation)...)
	return append(out, 0xFF, 0xDA, 0x00, 0x02, 0xFF, 0xD9)
}

// exifAPP1 returns a complete APP1 segment (marker, length, payload) holding
// IFD0 with a single orientation tag.
func exifAPP1(order binary.ByteOrder, orientation uint16) []byte {
	tiff := make([]byte, 8+2+12+4)
	if order == binary.LittleEndian {
		copy(tiff[0:2], "II")
	} else {
		copy(tiff[0:2], "MM")
	}
	order.PutUint16(tiff[2:4], 42)
	order.PutUint32(tiff[4:8], 8)
	order.PutUint16(tiff[8:10], 1)

	entry := tiff[10:22]
	order.PutUint16(entry[0:2], 0x0112)
	order.PutUint16(entry[2:4], 3)
	order.PutUint32(entry[4:8], 1)
	order.PutUint16(entry[8:10], orientation)

	payload := append([]byte("Exif\x00\x00"), tiff...)
	segment := make([]byte, 4, 4+len(payload))
	segment[0], segment[1] = 0xFF, 0xE1
	binary.BigEndian.PutUint16(segment[2:4], uint16(len(payload)+2))
	return append(segment, payload...)
}
