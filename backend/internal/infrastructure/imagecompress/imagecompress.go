// Package imagecompress prepares uploaded evidence for object storage: it
// shrinks oversized JPEG/PNG files and optimizes PDFs without ever failing an
// upload. Storage adapters call Prepare with bytes they already hold in memory
// and store the result, so every unsupported or unsafe input must pass through
// untouched rather than raising an error.
package imagecompress

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
	"golang.org/x/image/draw"
)

const (
	// MaxEdgePx bounds the longest output side. ID cards, site photos and
	// scanned SPK pages stay legible at 1600 px while storage and mobile data
	// use drop sharply.
	MaxEdgePx = 1600
	// JPEGQuality trades detail against size for re-encoded photos; 82 is
	// visually lossless for evidence screenshots and phone photos.
	JPEGQuality = 82
	// SkipBelowBytes avoids a decode/re-encode round trip for files too small
	// to yield a meaningful saving (512 KiB).
	SkipBelowBytes = 512 << 10
	// MaxPixels rejects pathological rasters whose decoded pixel buffers would
	// balloon memory during upload even when the compressed file is small.
	MaxPixels = 24_000_000
	// MaxDimension rejects extreme aspect ratios where one side alone would
	// still allocate or resample an unreasonable row/column count.
	MaxDimension = 8192
)

// Prepare returns a smaller copy of a JPEG or PNG upload, or the input
// unchanged when it is unsupported, already small, unsafe to re-encode, or
// would not shrink. It never returns an error: storage must not reject a visit
// attachment because compression could not help.
func Prepare(src []byte, mime string) (out []byte, outMIME string, changed bool) {
	if mime != "image/jpeg" && mime != "image/png" {
		return src, mime, false
	}
	if len(src) < SkipBelowBytes {
		return src, mime, false
	}

	cfg, _, err := image.DecodeConfig(bytes.NewReader(src))
	if err != nil || !decodeDimensionsAllowed(cfg.Width, cfg.Height) {
		return src, mime, false
	}

	// Re-encoding an EXIF-rotated photo would store the pixels sideways: Go's
	// decoder ignores the orientation tag, so leave all rotated variants alone.
	if mime == "image/jpeg" {
		if orientation, ok := jpegOrientation(src); ok && orientation >= 2 && orientation <= 8 {
			return src, mime, false
		}
	}

	img, _, err := image.Decode(bytes.NewReader(src))
	if err != nil {
		return src, mime, false
	}

	bounds := img.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	outWidth, outHeight := width, height
	if longest := max(width, height); longest > MaxEdgePx {
		outWidth, outHeight = scaledDimensions(width, height, longest)
	}

	var dst draw.Image
	if mime == "image/png" && !isOpaque(img) {
		dst = image.NewNRGBA(image.Rect(0, 0, outWidth, outHeight))
	} else {
		dst = image.NewRGBA(image.Rect(0, 0, outWidth, outHeight))
	}
	draw.CatmullRom.Scale(dst, dst.Bounds(), img, bounds, draw.Src, nil)

	var buf bytes.Buffer
	if mime == "image/jpeg" {
		if err := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: JPEGQuality}); err != nil {
			return src, mime, false
		}
	} else {
		encoder := png.Encoder{CompressionLevel: png.BestCompression}
		if err := encoder.Encode(&buf, dst); err != nil {
			return src, mime, false
		}
	}

	// A corrupt encoder output must never replace the original upload.
	if _, _, err := image.Decode(bytes.NewReader(buf.Bytes())); err != nil {
		return src, mime, false
	}
	if buf.Len() >= len(src) {
		return src, mime, false
	}

	return buf.Bytes(), mime, true
}

// OptimizePDF runs pdfcpu's optimization pass over an in-memory PDF. Only the
// storage adapter's large-PDF path calls this, so a non-PDF input is a caller
// bug worth surfacing as an error rather than silently storing it.
func OptimizePDF(src []byte) ([]byte, error) {
	if !bytes.HasPrefix(bytes.TrimSpace(src), []byte("%PDF-")) {
		return nil, fmt.Errorf("imagecompress: input is not a PDF")
	}

	conf := model.NewDefaultConfiguration()
	var out bytes.Buffer
	if err := api.Optimize(context.Background(), bytes.NewReader(src), &out, conf, nil); err != nil {
		return nil, fmt.Errorf("imagecompress: optimize pdf: %w", err)
	}

	// pdfcpu's pass is structural (object/xref streams, duplicate resources),
	// so on a small or already-tight file it can emit slightly MORE bytes than
	// it read. Handing that back would store a larger object for no benefit, so
	// a non-shrinking result falls back to the original — which the caller's
	// stored-size check then refuses when it is over the ceiling.
	if out.Len() >= len(src) {
		return src, nil
	}
	return out.Bytes(), nil
}

// decodeDimensionsAllowed enforces the memory guards before a full decode. It
// takes dimensions separately so boundary tests never allocate a real raster.
func decodeDimensionsAllowed(width, height int) bool {
	if width <= 0 || height <= 0 {
		return false
	}
	if width > MaxDimension || height > MaxDimension {
		return false
	}
	return int64(width)*int64(height) <= MaxPixels
}

// scaledDimensions keeps the aspect ratio while forcing the longest side to
// exactly MaxEdgePx. Integer math cannot overshoot the ceiling; callers only
// invoke it when longest is already above the limit, so this never upscales.
func scaledDimensions(width, height, longest int) (int, int) {
	scaledWidth := width * MaxEdgePx / longest
	scaledHeight := height * MaxEdgePx / longest
	if scaledWidth < 1 {
		scaledWidth = 1
	}
	if scaledHeight < 1 {
		scaledHeight = 1
	}
	return scaledWidth, scaledHeight
}

// isOpaque decides whether a PNG needs an alpha-capable destination. Images
// that cannot answer conservatively get NRGBA so transparency is not clipped.
func isOpaque(img image.Image) bool {
	type opaquer interface {
		Opaque() bool
	}
	if o, ok := img.(opaquer); ok {
		return o.Opaque()
	}
	return false
}
