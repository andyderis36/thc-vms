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

// TestJPEGEXIFOrientationState pins the tri-state contract that PrepareAvatar
// relies on: absent, valid, and malformed must stay distinguishable. The legacy
// jpegOrientation wrapper must keep reporting ok only for the valid state.
func TestJPEGEXIFOrientationState(t *testing.T) {
	sosOnly := []byte{0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x02, 0xFF, 0xD9}

	tests := []struct {
		name       string
		src        []byte
		wantValue  int
		wantState  exifState
		wantLegacy bool
	}{
		{
			name:      "no APP1 segment is absent",
			src:       sosOnly,
			wantState: exifAbsent,
		},
		{
			name:       "valid orientation 6",
			src:        jpegWithEXIF(binary.BigEndian, 6),
			wantValue:  6,
			wantState:  exifValid,
			wantLegacy: true,
		},
		{
			name:       "valid orientation 1",
			src:        jpegWithEXIF(binary.LittleEndian, 1),
			wantValue:  1,
			wantState:  exifValid,
			wantLegacy: true,
		},
		{
			name:      "orientation tag out of range is malformed",
			src:       jpegWithEXIF(binary.LittleEndian, 9),
			wantState: exifMalformed,
		},
		{
			name:      "corrupt TIFF magic is malformed",
			src:       jpegWithAPP1(corruptEXIFAPP1(binary.LittleEndian)),
			wantState: exifMalformed,
		},
		{
			name:      "EXIF header without TIFF block is malformed",
			src:       jpegWithAPP1(exifHeaderOnlyAPP1()),
			wantState: exifMalformed,
		},
		{
			name:      "truncated TIFF block is malformed",
			src:       jpegWithAPP1(truncatedTIFFAPP1(binary.LittleEndian)),
			wantState: exifMalformed,
		},
		{
			name:      "APP1 without EXIF signature is absent",
			src:       jpegWithAPP1(app1Segment([]byte("JFIF\x00\x01\x01"))),
			wantState: exifAbsent,
		},
		{
			name:      "APP1 claiming more bytes than the file holds is malformed",
			src:       []byte{0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x40, 'E', 'x'},
			wantState: exifMalformed,
		},
		{
			name:      "not a JPEG is absent",
			src:       []byte("this is not an image"),
			wantState: exifAbsent,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			value, state := jpegEXIFOrientation(tt.src)
			if value != tt.wantValue || state != tt.wantState {
				t.Fatalf("jpegEXIFOrientation() = (%d, %v), want (%d, %v)", value, state, tt.wantValue, tt.wantState)
			}

			legacyValue, legacyOK := jpegOrientation(tt.src)
			if legacyOK != tt.wantLegacy {
				t.Fatalf("jpegOrientation() ok = %v, want %v", legacyOK, tt.wantLegacy)
			}
			if legacyOK && legacyValue != tt.wantValue {
				t.Fatalf("jpegOrientation() = %d, want %d", legacyValue, tt.wantValue)
			}
		})
	}
}

// jpegWithEXIF builds a marker-only JPEG carrying one APP1 EXIF block. The
// parser never needs pixel data, so the SOS marker is enough to stop the walk.
func jpegWithEXIF(order binary.ByteOrder, orientation uint16) []byte {
	return jpegWithAPP1(exifAPP1(order, orientation))
}

// jpegWithAPP1 builds a marker-only JPEG around an already assembled APP1
// segment.
func jpegWithAPP1(app1 []byte) []byte {
	out := []byte{0xFF, 0xD8}
	out = append(out, app1...)
	return append(out, 0xFF, 0xDA, 0x00, 0x02, 0xFF, 0xD9)
}

// injectAPP1 inserts a complete APP1 segment immediately after the SOI marker
// of a real JPEG, keeping the rest of the file byte-identical.
func injectAPP1(src, app1 []byte) []byte {
	out := make([]byte, 0, len(src)+len(app1))
	out = append(out, src[:2]...)
	out = append(out, app1...)
	return append(out, src[2:]...)
}

// corruptEXIFAPP1 returns a structurally valid APP1 segment whose TIFF magic is
// no longer 42.
func corruptEXIFAPP1(order binary.ByteOrder) []byte {
	app1 := exifAPP1(order, 6)
	app1[12] = 0x00
	return app1
}

// exifHeaderOnlyAPP1 returns a structurally valid APP1 segment that carries the
// EXIF signature but no TIFF block at all.
func exifHeaderOnlyAPP1() []byte {
	return app1Segment([]byte("Exif\x00\x00"))
}

// truncatedTIFFAPP1 returns a structurally valid APP1 segment holding only the
// first five bytes of a TIFF header: long enough to be recognised as EXIF, too
// short to read an orientation from.
func truncatedTIFFAPP1(order binary.ByteOrder) []byte {
	full := exifAPP1(order, 6)
	tiff := full[10:]
	return app1Segment(append([]byte("Exif\x00\x00"), tiff[:5]...))
}

// app1Segment wraps payload in an APP1 marker with an accurate length field, so
// the surrounding JPEG marker chain stays walkable.
func app1Segment(payload []byte) []byte {
	segment := make([]byte, 4, 4+len(payload))
	segment[0], segment[1] = 0xFF, 0xE1
	binary.BigEndian.PutUint16(segment[2:4], uint16(len(payload)+2))
	return append(segment, payload...)
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
