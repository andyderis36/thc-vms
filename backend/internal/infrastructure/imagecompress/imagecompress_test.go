package imagecompress

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"testing"
)

func TestPrepareDownscalesNoisyJPEG(t *testing.T) {
	src := noisyJPEG(t, 3200, 2000)
	if len(src) < SkipBelowBytes {
		t.Fatalf("fixture too small to exercise compression: %d bytes", len(src))
	}

	out, mime, changed := Prepare(src, "image/jpeg")
	if !changed {
		t.Fatal("Prepare() did not compress a noisy 3200x2000 JPEG")
	}
	if mime != "image/jpeg" {
		t.Fatalf("Prepare() mime = %q, want image/jpeg", mime)
	}

	img, format, err := image.Decode(bytes.NewReader(out))
	if err != nil {
		t.Fatalf("compressed output does not decode: %v", err)
	}
	if format != "jpeg" {
		t.Fatalf("compressed output format = %q, want jpeg", format)
	}
	if longest := max(img.Bounds().Dx(), img.Bounds().Dy()); longest > MaxEdgePx {
		t.Fatalf("longest side = %d, want <= %d", longest, MaxEdgePx)
	}
	if got := max(img.Bounds().Dx(), img.Bounds().Dy()); got != MaxEdgePx {
		t.Fatalf("longest side = %d, want exactly %d after downscale", got, MaxEdgePx)
	}
	if len(out) >= len(src) {
		t.Fatalf("compressed size = %d, want < original %d", len(out), len(src))
	}
}

func TestPrepareKeepsPNGAsPNG(t *testing.T) {
	src := largePNG(t, 900, 600)
	if len(src) < SkipBelowBytes {
		t.Fatalf("fixture too small to exercise compression: %d bytes", len(src))
	}

	out, mime, changed := Prepare(src, "image/png")
	if !changed {
		t.Fatal("Prepare() did not recompress a 900x600 PNG")
	}
	if mime != "image/png" {
		t.Fatalf("Prepare() mime = %q, want image/png", mime)
	}
	if !bytes.HasPrefix(out, []byte("\x89PNG\r\n\x1a\n")) {
		t.Fatal("output is no longer a PNG")
	}

	cfg, format, err := image.DecodeConfig(bytes.NewReader(out))
	if err != nil {
		t.Fatalf("compressed PNG does not decode: %v", err)
	}
	if format != "png" {
		t.Fatalf("compressed output format = %q, want png", format)
	}
	if longest := max(cfg.Width, cfg.Height); longest > MaxEdgePx {
		t.Fatalf("longest side = %d, want <= %d", longest, MaxEdgePx)
	}
	if len(out) >= len(src) {
		t.Fatalf("compressed size = %d, want < original %d", len(out), len(src))
	}
}

func TestPreparePassesThroughNonImage(t *testing.T) {
	src := pseudoRandomBytes(700<<10, 0xC0FFEE)
	out, mime, changed := Prepare(src, "image/jpeg")
	if changed {
		t.Fatal("Prepare() claimed to compress random bytes")
	}
	if mime != "image/jpeg" {
		t.Fatalf("Prepare() mime = %q, want image/jpeg", mime)
	}
	if !bytes.Equal(out, src) {
		t.Fatal("Prepare() altered non-image input")
	}
}

func TestPrepareSkipsSmallPNG(t *testing.T) {
	var buf bytes.Buffer
	img := image.NewNRGBA(image.Rect(0, 0, 1, 1))
	img.SetNRGBA(0, 0, color.NRGBA{R: 12, G: 34, B: 56, A: 255})
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode fixture: %v", err)
	}
	src := buf.Bytes()
	if len(src) >= SkipBelowBytes {
		t.Fatalf("fixture exceeds skip threshold: %d", len(src))
	}

	out, mime, changed := Prepare(src, "image/png")
	if changed {
		t.Fatal("Prepare() compressed a PNG below the skip threshold")
	}
	if mime != "image/png" {
		t.Fatalf("Prepare() mime = %q, want image/png", mime)
	}
	if !bytes.Equal(out, src) {
		t.Fatal("Prepare() altered a small PNG")
	}
}

func TestPrepareLeavesEXIFRotatedJPEGAlone(t *testing.T) {
	base := noisyJPEG(t, 1600, 1200)
	for orientation := uint16(2); orientation <= 8; orientation++ {
		t.Run(fmt.Sprintf("orientation_%d", orientation), func(t *testing.T) {
			src := injectEXIF(base, orientation)
			if len(src) < SkipBelowBytes {
				t.Fatalf("fixture too small to reach EXIF check: %d bytes", len(src))
			}

			out, mime, changed := Prepare(src, "image/jpeg")
			if changed {
				t.Fatal("Prepare() re-encoded an EXIF-rotated JPEG")
			}
			if mime != "image/jpeg" {
				t.Fatalf("Prepare() mime = %q, want image/jpeg", mime)
			}
			if !bytes.Equal(out, src) {
				t.Fatal("Prepare() altered an EXIF-rotated JPEG")
			}
		})
	}
}

func TestPreparePassesThroughTruncatedJPEG(t *testing.T) {
	src := noisyJPEG(t, 1600, 1200)
	src = src[:len(src)/2]
	if len(src) < SkipBelowBytes {
		t.Fatalf("truncated fixture fell below skip threshold: %d bytes", len(src))
	}
	if _, _, err := image.DecodeConfig(bytes.NewReader(src)); err != nil {
		t.Fatalf("truncated fixture should still expose a header: %v", err)
	}

	out, mime, changed := Prepare(src, "image/jpeg")
	if changed {
		t.Fatal("Prepare() claimed to compress a truncated JPEG")
	}
	if mime != "image/jpeg" {
		t.Fatalf("Prepare() mime = %q, want image/jpeg", mime)
	}
	if !bytes.Equal(out, src) {
		t.Fatal("Prepare() altered a truncated JPEG")
	}
}

func TestDecodeDimensionsAllowed(t *testing.T) {
	tests := []struct {
		name          string
		width, height int
		want          bool
	}{
		{name: "exactly at pixel cap", width: 6000, height: 4000, want: true},
		{name: "one pixel over cap", width: 6001, height: 4000, want: false},
		{name: "exactly at dimension cap", width: 8192, height: 1, want: true},
		{name: "one over dimension cap", width: 8193, height: 1, want: false},
		{name: "tall image at dimension cap", width: 1, height: 8192, want: true},
		{name: "zero width", width: 0, height: 100, want: false},
		{name: "negative height", width: 100, height: -1, want: false},
		{name: "wide image under both caps", width: 4000, height: 6000, want: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := decodeDimensionsAllowed(tt.width, tt.height); got != tt.want {
				t.Fatalf("decodeDimensionsAllowed(%d, %d) = %v, want %v", tt.width, tt.height, got, tt.want)
			}
		})
	}
}

func TestScaledDimensions(t *testing.T) {
	tests := []struct {
		name                   string
		width, height, longest int
		wantWidth, wantHeight  int
	}{
		{name: "landscape", width: 3200, height: 2000, longest: 3200, wantWidth: 1600, wantHeight: 1000},
		{name: "portrait", width: 2000, height: 3200, longest: 3200, wantWidth: 1000, wantHeight: 1600},
		{name: "square", width: 4000, height: 4000, longest: 4000, wantWidth: 1600, wantHeight: 1600},
		{name: "extreme ratio keeps one pixel", width: 8192, height: 1, longest: 8192, wantWidth: 1600, wantHeight: 1},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotWidth, gotHeight := scaledDimensions(tt.width, tt.height, tt.longest)
			if gotWidth != tt.wantWidth || gotHeight != tt.wantHeight {
				t.Fatalf("scaledDimensions(%d, %d, %d) = (%d, %d), want (%d, %d)",
					tt.width, tt.height, tt.longest, gotWidth, gotHeight, tt.wantWidth, tt.wantHeight)
			}
		})
	}
}

func TestOptimizePDFRejectsNonPDF(t *testing.T) {
	if out, err := OptimizePDF([]byte("definitely not a pdf")); err == nil {
		t.Fatalf("OptimizePDF() error = nil, want error (out %d bytes)", len(out))
	}
	if out, err := OptimizePDF(nil); err == nil {
		t.Fatalf("OptimizePDF(nil) error = nil, want error (out %d bytes)", len(out))
	}
}

func TestOptimizePDFReturnsPDF(t *testing.T) {
	src := minimalPDF()
	out, err := OptimizePDF(src)
	if err != nil {
		t.Fatalf("OptimizePDF() error = %v", err)
	}
	if !bytes.HasPrefix(out, []byte("%PDF-")) {
		t.Fatalf("optimized output does not start with %%PDF-: %q", out[:min(len(out), 8)])
	}
	if len(out) > len(src) {
		t.Fatalf("optimized PDF grew: %d > %d bytes", len(out), len(src))
	}
}

// noisyJPEG builds a high-entropy photo-like JPEG so compression has real work
// to do and the fixture comfortably exceeds the skip threshold.
func noisyJPEG(t *testing.T, width, height int) []byte {
	t.Helper()

	img := image.NewRGBA(image.Rect(0, 0, width, height))
	state := uint32(0x9E3779B9)
	for y := 0; y < height; y++ {
		row := img.Pix[y*img.Stride : y*img.Stride+width*4]
		for x := 0; x < width; x++ {
			state = state*1664525 + 1013904223
			row[x*4+0] = byte(state >> 24)
			row[x*4+1] = byte(state >> 16)
			row[x*4+2] = byte(state >> 8)
			row[x*4+3] = 0xFF
		}
	}

	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatalf("encode JPEG fixture: %v", err)
	}
	return buf.Bytes()
}

// largePNG stores smooth rows without compression so the fixture is far larger
// than the same image re-encoded with BestCompression.
func largePNG(t *testing.T, width, height int) []byte {
	t.Helper()

	img := image.NewNRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		row := img.Pix[y*img.Stride : y*img.Stride+width*4]
		for x := 0; x < width; x++ {
			row[x*4+0] = byte(x * 255 / width)
			row[x*4+1] = byte(y * 255 / height)
			row[x*4+2] = byte((x + y) % 256)
			row[x*4+3] = 0xFF
		}
	}

	var buf bytes.Buffer
	encoder := png.Encoder{CompressionLevel: png.NoCompression}
	if err := encoder.Encode(&buf, img); err != nil {
		t.Fatalf("encode PNG fixture: %v", err)
	}
	return buf.Bytes()
}

func pseudoRandomBytes(size int, seed uint32) []byte {
	out := make([]byte, size)
	state := seed
	for i := range out {
		state = state*1664525 + 1013904223
		out[i] = byte(state >> 24)
	}
	return out
}

// injectEXIF inserts an APP1 orientation segment immediately after SOI. Go's
// JPEG decoder ignores it, which is exactly the behaviour Prepare must defend
// against.
func injectEXIF(src []byte, orientation uint16) []byte {
	app1 := exifAPP1(binary.LittleEndian, orientation)
	out := make([]byte, 0, len(src)+len(app1))
	out = append(out, src[:2]...)
	out = append(out, app1...)
	return append(out, src[2:]...)
}

// minimalPDF assembles a one-page PDF with correct xref offsets so pdfcpu's
// validating optimizer accepts it.
func minimalPDF() []byte {
	var buf bytes.Buffer
	buf.WriteString("%PDF-1.4\n")

	offsets := make([]int, 5)
	writeObject := func(number int, body string) {
		offsets[number] = buf.Len()
		fmt.Fprintf(&buf, "%d 0 obj\n%s\nendobj\n", number, body)
	}

	writeObject(1, "<< /Type /Catalog /Pages 2 0 R >>")
	writeObject(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
	writeObject(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << >> >>")
	content := "0 0 1 rg 20 20 160 160 re f"
	writeObject(4, fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(content), content))

	xrefOffset := buf.Len()
	buf.WriteString("xref\n0 5\n0000000000 65535 f \n")
	for number := 1; number <= 4; number++ {
		fmt.Fprintf(&buf, "%010d 00000 n \n", offsets[number])
	}
	fmt.Fprintf(&buf, "trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", xrefOffset)

	return buf.Bytes()
}
