package imagecompress

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"

	"golang.org/x/image/draw"
)

// AvatarMaxEdgePx is the side of the square avatar stored for a user profile.
// Avatars render in 40-96 px chips, so 512 px stays crisp on high-DPI screens
// while keeping the stored object small.
const AvatarMaxEdgePx = 512

// PrepareAvatar normalizes a profile photo into a square JPEG of at most
// AvatarMaxEdgePx per side. Unlike Prepare it is strict: the caller stores the
// bytes it returns, so an input that cannot be decoded or encoded is an error
// instead of a silent pass-through.
//
// changed is false only when src is already a reusable square JPEG (see
// reusableAvatarJPEG); in that case out is the original slice.
func PrepareAvatar(src []byte) (out []byte, changed bool, err error) {
	if reusableAvatarJPEG(src) {
		return src, false, nil
	}

	cfg, format, err := image.DecodeConfig(bytes.NewReader(src))
	if err != nil {
		return nil, false, fmt.Errorf("imagecompress: avatar header is not a decodable image: %w", err)
	}
	if format != "jpeg" && format != "png" {
		return nil, false, fmt.Errorf("imagecompress: unsupported avatar format %q", format)
	}
	if !decodeDimensionsAllowed(cfg.Width, cfg.Height) {
		return nil, false, fmt.Errorf("imagecompress: avatar dimensions %dx%d exceed the supported limits", cfg.Width, cfg.Height)
	}

	img, _, err := image.Decode(bytes.NewReader(src))
	if err != nil {
		return nil, false, fmt.Errorf("imagecompress: avatar pixels are not decodable: %w", err)
	}

	// A malformed EXIF block is ignored on purpose: the pixels are still
	// usable and only the rotation hint is lost, so re-encoding unrotated is
	// better than rejecting the upload.
	if format == "jpeg" {
		if orientation, state := jpegEXIFOrientation(src); state == exifValid && orientation >= 2 && orientation <= 8 {
			img = applyOrientation(img, orientation)
		}
	}

	square := centerCropRect(img.Bounds())
	side := min(AvatarMaxEdgePx, square.Dx())

	// JPEG has no alpha channel. Painting white first and compositing with
	// draw.Over keeps transparent PNG regions white instead of black.
	dst := image.NewRGBA(image.Rect(0, 0, side, side))
	draw.Draw(dst, dst.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	draw.CatmullRom.Scale(dst, dst.Bounds(), img, square, draw.Over, nil)

	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: JPEGQuality}); err != nil {
		return nil, false, fmt.Errorf("imagecompress: encode avatar: %w", err)
	}
	return buf.Bytes(), true, nil
}

// reusableAvatarJPEG reports whether src can be stored as-is: a square JPEG of
// at most AvatarMaxEdgePx per side whose EXIF orientation is either missing or
// the identity. Every check must pass, so a truncated or malformed EXIF block
// forces a re-encode instead of being trusted.
func reusableAvatarJPEG(src []byte) bool {
	cfg, format, err := image.DecodeConfig(bytes.NewReader(src))
	if err != nil || format != "jpeg" {
		return false
	}
	if cfg.Width != cfg.Height || cfg.Width < 1 || cfg.Width > AvatarMaxEdgePx {
		return false
	}

	switch orientation, state := jpegEXIFOrientation(src); state {
	case exifAbsent:
	case exifValid:
		if orientation != 1 {
			return false
		}
	case exifMalformed:
		return false
	default:
		return false
	}

	if _, _, err := image.Decode(bytes.NewReader(src)); err != nil {
		return false
	}
	return true
}

// applyOrientation rotates or mirrors img according to an EXIF orientation
// value in 2..8. Any other value, including 1, returns img unchanged.
//
// The result is a fresh image so callers never alias the decoded one, and it
// uses a plain pixel mapping instead of an interpolating transform: an EXIF
// rotation must not soften the photo.
func applyOrientation(img image.Image, orientation int) image.Image {
	if img == nil || orientation < 2 || orientation > 8 {
		return img
	}

	bounds := img.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	if width < 1 || height < 1 {
		return img
	}

	outWidth, outHeight := width, height
	if orientation >= 5 {
		// Orientations 5..8 transpose the raster, swapping the sides.
		outWidth, outHeight = height, width
	}

	dst := image.NewRGBA(image.Rect(0, 0, outWidth, outHeight))
	for y := 0; y < outHeight; y++ {
		for x := 0; x < outWidth; x++ {
			var srcX, srcY int
			switch orientation {
			case 2: // mirror horizontal
				srcX, srcY = width-1-x, y
			case 3: // rotate 180
				srcX, srcY = width-1-x, height-1-y
			case 4: // mirror vertical
				srcX, srcY = x, height-1-y
			case 5: // transpose
				srcX, srcY = y, x
			case 6: // rotate 90 clockwise
				srcX, srcY = y, height-1-x
			case 7: // transverse
				srcX, srcY = width-1-y, height-1-x
			case 8: // rotate 90 counter-clockwise
				srcX, srcY = width-1-y, x
			}
			dst.Set(x, y, img.At(bounds.Min.X+srcX, bounds.Min.Y+srcY))
		}
	}
	return dst
}

// centerCropRect returns the largest square centred inside bounds. Cropping
// rather than letterboxing keeps a portrait selfie filling the avatar circle.
func centerCropRect(bounds image.Rectangle) image.Rectangle {
	width, height := bounds.Dx(), bounds.Dy()
	side := min(width, height)
	if side < 1 {
		return bounds
	}
	left := bounds.Min.X + (width-side)/2
	top := bounds.Min.Y + (height-side)/2
	return image.Rect(left, top, left+side, top+side)
}
