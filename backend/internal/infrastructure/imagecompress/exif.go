package imagecompress

import "encoding/binary"

// exifState distinguishes the three outcomes of walking a JPEG for an EXIF
// orientation tag. Callers need the difference: a file with no EXIF block can
// be trusted as-is, while a file carrying a broken EXIF block must be
// re-encoded rather than passed through.
type exifState int

const (
	// exifAbsent means the JPEG has no APP1 EXIF segment at all.
	exifAbsent exifState = iota
	// exifValid means an EXIF block was found and carries a usable 1..8 tag.
	exifValid
	// exifMalformed means an EXIF block exists but its orientation tag is
	// missing, truncated, or otherwise unreadable.
	exifMalformed
)

// jpegOrientation reports the EXIF orientation tag of a JPEG. Go's image/jpeg
// decoder ignores EXIF, so re-encoding a rotated photo would bake the rotation
// into a sideways raster; Prepare must leave those files untouched instead.
//
// ok is true only for a valid 1..8 value. Callers that need to tell "no EXIF"
// apart from "broken EXIF" use jpegEXIFOrientation directly.
func jpegOrientation(src []byte) (orientation int, ok bool) {
	orientation, state := jpegEXIFOrientation(src)
	if state != exifValid {
		return 0, false
	}
	return orientation, true
}

// jpegEXIFOrientation walks JPEG markers up to the image data and then the
// first TIFF IFD, returning the orientation together with how trustworthy the
// result is. The parser is deliberately self-contained: pulling an EXIF library
// in for a single SHORT tag would add a dependency to every upload path.
//
// A segment that claims more bytes than the file holds, a TIFF block with a bad
// header, or an orientation tag with an out-of-range value is malformed — never
// silently treated as absent.
func jpegEXIFOrientation(src []byte) (orientation int, state exifState) {
	if len(src) < 2 || src[0] != 0xFF || src[1] != 0xD8 {
		return 0, exifAbsent
	}

	for i := 2; i+1 < len(src); {
		if src[i] != 0xFF {
			return 0, exifMalformed
		}
		for i < len(src) && src[i] == 0xFF {
			i++
		}
		if i >= len(src) {
			return 0, exifMalformed
		}

		marker := src[i]
		i++

		// Standalone markers carry no length field.
		if marker == 0xD8 || marker == 0x01 || (marker >= 0xD0 && marker <= 0xD7) {
			continue
		}
		// Start of scan / end of image: EXIF APP1, when present, came earlier.
		if marker == 0xDA || marker == 0xD9 {
			return 0, exifAbsent
		}
		if i+2 > len(src) {
			return 0, exifMalformed
		}

		segmentLen := int(binary.BigEndian.Uint16(src[i : i+2]))
		if segmentLen < 2 {
			return 0, exifMalformed
		}
		segmentEnd := i + segmentLen
		if segmentEnd > len(src) {
			return 0, exifMalformed
		}

		if marker == 0xE1 && segmentLen >= 2+6 && string(src[i+2:i+8]) == "Exif\x00\x00" {
			if o, ok := tiffOrientation(src[i+8 : segmentEnd]); ok {
				return o, exifValid
			}
			// An EXIF block we cannot read is still an EXIF block: report it
			// as malformed so callers re-encode instead of trusting the bytes.
			return 0, exifMalformed
		}

		i = segmentEnd
	}

	return 0, exifAbsent
}

// tiffOrientation reads tag 0x0112 from IFD0 of an EXIF TIFF block. Values
// outside 1..8 are treated as unusable so a corrupt tag cannot block
// compression.
func tiffOrientation(tiff []byte) (int, bool) {
	if len(tiff) < 8 {
		return 0, false
	}

	var order binary.ByteOrder
	switch string(tiff[0:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return 0, false
	}

	if order.Uint16(tiff[2:4]) != 42 {
		return 0, false
	}

	ifdOffset := int(order.Uint32(tiff[4:8]))
	if ifdOffset < 8 || ifdOffset+2 > len(tiff) {
		return 0, false
	}

	entryCount := int(order.Uint16(tiff[ifdOffset : ifdOffset+2]))
	entriesStart := ifdOffset + 2
	if entryCount > (len(tiff)-entriesStart)/12 {
		return 0, false
	}

	for n := 0; n < entryCount; n++ {
		entry := tiff[entriesStart+n*12 : entriesStart+(n+1)*12]
		if order.Uint16(entry[0:2]) != 0x0112 {
			continue
		}
		// Type 3 is SHORT; anything else is not a usable orientation.
		if order.Uint16(entry[2:4]) != 3 || order.Uint32(entry[4:8]) < 1 {
			return 0, false
		}
		value := int(order.Uint16(entry[8:10]))
		if value < 1 || value > 8 {
			return 0, false
		}
		return value, true
	}

	return 0, false
}
