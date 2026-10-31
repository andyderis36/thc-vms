package imagecompress

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"testing"
)

func TestPrepareAvatarPassesThroughReusableJPEG(t *testing.T) {
	src := gradientJPEG(t, AvatarMaxEdgePx, AvatarMaxEdgePx)
	if !reusableAvatarJPEG(src) {
		t.Fatal("fixture should be a reusable avatar JPEG")
	}

	out, changed, err := PrepareAvatar(src)
	if err != nil {
		t.Fatalf("PrepareAvatar() error = %v", err)
	}
	if changed {
		t.Fatal("PrepareAvatar() re-encoded an already reusable JPEG")
	}
	if !bytes.Equal(out, src) {
		t.Fatal("PrepareAvatar() altered a reusable JPEG")
	}
}

func TestPrepareAvatarPassesThroughOrientationOne(t *testing.T) {
	src := injectEXIF(gradientJPEG(t, AvatarMaxEdgePx, AvatarMaxEdgePx), 1)
	if !reusableAvatarJPEG(src) {
		t.Fatal("orientation 1 fixture should be reusable")
	}

	out, changed, err := PrepareAvatar(src)
	if err != nil {
		t.Fatalf("PrepareAvatar() error = %v", err)
	}
	if changed {
		t.Fatal("PrepareAvatar() re-encoded an identity-orientation JPEG")
	}
	if !bytes.Equal(out, src) {
		t.Fatal("PrepareAvatar() altered an identity-orientation JPEG")
	}
}

func TestPrepareAvatarReencodesWhenNotReusable(t *testing.T) {
	tests := []struct {
		name string
		src  []byte
		side int
	}{
		{
			name: "non square",
			src:  noisyJPEG(t, 640, 480),
			side: 480,
		},
		{
			name: "513 square",
			src:  noisyJPEG(t, 513, 513),
			side: 512,
		},
		{
			name: "orientation 6",
			src:  injectEXIF(noisyJPEG(t, 640, 480), 6),
			side: 480,
		},
		{
			name: "orientation 8",
			src:  injectEXIF(noisyJPEG(t, 640, 480), 8),
			side: 480,
		},
		{
			name: "malformed EXIF",
			src:  injectAPP1(gradientJPEG(t, 512, 512), corruptEXIFAPP1(binary.LittleEndian)),
			side: 512,
		},
		{
			name: "truncated EXIF",
			src:  injectAPP1(gradientJPEG(t, 512, 512), truncatedTIFFAPP1(binary.LittleEndian)),
			side: 512,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if reusableAvatarJPEG(tt.src) {
				t.Fatal("fixture must not be reusable")
			}

			out, changed, err := PrepareAvatar(tt.src)
			if err != nil {
				t.Fatalf("PrepareAvatar() error = %v", err)
			}
			if !changed {
				t.Fatal("PrepareAvatar() reported no change")
			}

			img, format, err := image.Decode(bytes.NewReader(out))
			if err != nil {
				t.Fatalf("avatar output does not decode: %v", err)
			}
			if format != "jpeg" {
				t.Fatalf("avatar output format = %q, want jpeg", format)
			}
			if got := img.Bounds().Dx(); got != tt.side {
				t.Fatalf("avatar width = %d, want %d", got, tt.side)
			}
			if got := img.Bounds().Dy(); got != tt.side {
				t.Fatalf("avatar height = %d, want %d", got, tt.side)
			}
		})
	}
}

func TestPrepareAvatarDimensions(t *testing.T) {
	tests := []struct {
		name string
		src  []byte
		side int
	}{
		{name: "1200x800", src: noisyJPEG(t, 1200, 800), side: 512},
		{name: "320x240", src: noisyJPEG(t, 320, 240), side: 240},
		{name: "200x100 never upscales", src: noisyJPEG(t, 200, 100), side: 100},
		{name: "100x100 PNG never upscales", src: gradientPNG(t, 100, 100), side: 100},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			out, changed, err := PrepareAvatar(tt.src)
			if err != nil {
				t.Fatalf("PrepareAvatar() error = %v", err)
			}
			if !changed {
				t.Fatal("PrepareAvatar() reported no change")
			}

			cfg, format, err := image.DecodeConfig(bytes.NewReader(out))
			if err != nil {
				t.Fatalf("avatar output does not decode: %v", err)
			}
			if format != "jpeg" {
				t.Fatalf("avatar output format = %q, want jpeg", format)
			}
			if cfg.Width != tt.side || cfg.Height != tt.side {
				t.Fatalf("avatar size = %dx%d, want %dx%d", cfg.Width, cfg.Height, tt.side, tt.side)
			}
		})
	}
}

func TestPrepareAvatarConvertsPNGToJPEG(t *testing.T) {
	out, changed, err := PrepareAvatar(gradientPNG(t, 300, 200))
	if err != nil {
		t.Fatalf("PrepareAvatar() error = %v", err)
	}
	if !changed {
		t.Fatal("PrepareAvatar() reported no change for a PNG")
	}
	if !bytes.HasPrefix(out, []byte{0xFF, 0xD8, 0xFF}) {
		t.Fatal("avatar output is not a JPEG")
	}

	cfg, format, err := image.DecodeConfig(bytes.NewReader(out))
	if err != nil {
		t.Fatalf("avatar output does not decode: %v", err)
	}
	if format != "jpeg" {
		t.Fatalf("avatar output format = %q, want jpeg", format)
	}
	if cfg.Width != 200 || cfg.Height != 200 {
		t.Fatalf("avatar size = %dx%d, want 200x200", cfg.Width, cfg.Height)
	}
}

func TestPrepareAvatarFlattensAlphaOntoWhite(t *testing.T) {
	out, changed, err := PrepareAvatar(alphaHalfPNG(t, 300, 200))
	if err != nil {
		t.Fatalf("PrepareAvatar() error = %v", err)
	}
	if !changed {
		t.Fatal("PrepareAvatar() reported no change for an alpha PNG")
	}

	img, _, err := image.Decode(bytes.NewReader(out))
	if err != nil {
		t.Fatalf("avatar output does not decode: %v", err)
	}
	if bounds := img.Bounds(); bounds.Dx() != 200 || bounds.Dy() != 200 {
		t.Fatalf("avatar size = %dx%d, want 200x200", bounds.Dx(), bounds.Dy())
	}

	// Transparent pixels must land on white, not on JPEG's default black.
	r, g, b, _ := img.At(10, 100).RGBA()
	if r>>8 < 240 || g>>8 < 240 || b>>8 < 240 {
		t.Fatalf("transparent region = (%d, %d, %d), want near white", r>>8, g>>8, b>>8)
	}

	// Opaque red must survive the white composite.
	r, g, b, _ = img.At(190, 100).RGBA()
	if r>>8 < 200 || g>>8 > 90 || b>>8 > 90 {
		t.Fatalf("opaque region = (%d, %d, %d), want near red", r>>8, g>>8, b>>8)
	}
}

func TestPrepareAvatarRejectsUndecodableInput(t *testing.T) {
	truncated := noisyJPEG(t, 512, 512)
	truncated = truncated[:len(truncated)*3/5]
	if _, _, err := image.DecodeConfig(bytes.NewReader(truncated)); err != nil {
		t.Fatalf("truncated fixture lost its header: %v", err)
	}

	tests := []struct {
		name string
		src  []byte
	}{
		{name: "corrupt bytes", src: pseudoRandomBytes(4096, 0x5EED)},
		{name: "PDF bytes", src: minimalPDF()},
		{name: "truncated pixel data", src: truncated},
		{name: "empty input", src: nil},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			out, changed, err := PrepareAvatar(tt.src)
			if err == nil {
				t.Fatalf("PrepareAvatar() error = nil, want error (out %d bytes, changed %v)", len(out), changed)
			}
			if out != nil {
				t.Fatalf("PrepareAvatar() returned %d bytes alongside an error", len(out))
			}
			if changed {
				t.Fatal("PrepareAvatar() reported a change alongside an error")
			}
		})
	}
}

func TestReusableAvatarJPEG(t *testing.T) {
	square512 := gradientJPEG(t, 512, 512)
	truncatedSquare := noisyJPEG(t, 512, 512)
	truncatedSquare = truncatedSquare[:len(truncatedSquare)*3/5]
	if _, _, err := image.DecodeConfig(bytes.NewReader(truncatedSquare)); err != nil {
		t.Fatalf("truncated fixture lost its header: %v", err)
	}

	tests := []struct {
		name string
		src  []byte
		want bool
	}{
		{name: "square 512 without EXIF", src: square512, want: true},
		{name: "square 512 orientation 1", src: injectEXIF(square512, 1), want: true},
		{name: "square 1 pixel", src: gradientJPEG(t, 1, 1), want: true},
		{name: "square 512 orientation 6", src: injectEXIF(square512, 6), want: false},
		{name: "square 512 malformed EXIF", src: injectAPP1(square512, corruptEXIFAPP1(binary.LittleEndian)), want: false},
		{name: "square 512 truncated EXIF", src: injectAPP1(square512, truncatedTIFFAPP1(binary.LittleEndian)), want: false},
		{name: "non square", src: gradientJPEG(t, 640, 480), want: false},
		{name: "513 square", src: gradientJPEG(t, 513, 513), want: false},
		{name: "PNG", src: gradientPNG(t, 512, 512), want: false},
		{name: "random bytes", src: pseudoRandomBytes(4096, 0xC0FFEE), want: false},
		{name: "truncated pixel data", src: truncatedSquare, want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := reusableAvatarJPEG(tt.src); got != tt.want {
				t.Fatalf("reusableAvatarJPEG() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestApplyOrientation(t *testing.T) {
	source := [2][3]color.RGBA{
		{{255, 0, 0, 255}, {0, 255, 0, 255}, {0, 0, 255, 255}},
		{{255, 255, 0, 255}, {255, 0, 255, 255}, {0, 255, 255, 255}},
	}
	img := image.NewRGBA(image.Rect(0, 0, 3, 2))
	for y := range source {
		for x := range source[y] {
			img.SetRGBA(x, y, source[y][x])
		}
	}

	tests := []struct {
		name        string
		orientation int
		want        [][]color.RGBA
	}{
		{
			name:        "orientation 1 keeps the raster",
			orientation: 1,
			want:        [][]color.RGBA{source[0][:], source[1][:]},
		},
		{
			name:        "orientation 2 mirrors horizontally",
			orientation: 2,
			want: [][]color.RGBA{
				{source[0][2], source[0][1], source[0][0]},
				{source[1][2], source[1][1], source[1][0]},
			},
		},
		{
			name:        "orientation 3 rotates 180",
			orientation: 3,
			want: [][]color.RGBA{
				{source[1][2], source[1][1], source[1][0]},
				{source[0][2], source[0][1], source[0][0]},
			},
		},
		{
			name:        "orientation 4 mirrors vertically",
			orientation: 4,
			want: [][]color.RGBA{
				{source[1][0], source[1][1], source[1][2]},
				{source[0][0], source[0][1], source[0][2]},
			},
		},
		{
			name:        "orientation 5 transposes",
			orientation: 5,
			want: [][]color.RGBA{
				{source[0][0], source[1][0]},
				{source[0][1], source[1][1]},
				{source[0][2], source[1][2]},
			},
		},
		{
			name:        "orientation 6 rotates 90 clockwise",
			orientation: 6,
			want: [][]color.RGBA{
				{source[1][0], source[0][0]},
				{source[1][1], source[0][1]},
				{source[1][2], source[0][2]},
			},
		},
		{
			name:        "orientation 7 is transverse",
			orientation: 7,
			want: [][]color.RGBA{
				{source[1][2], source[0][2]},
				{source[1][1], source[0][1]},
				{source[1][0], source[0][0]},
			},
		},
		{
			name:        "orientation 8 rotates 90 counter-clockwise",
			orientation: 8,
			want: [][]color.RGBA{
				{source[0][2], source[1][2]},
				{source[0][1], source[1][1]},
				{source[0][0], source[1][0]},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := applyOrientation(img, tt.orientation)
			assertPixelGrid(t, got, tt.want)
		})
	}
}

func TestCenterCropRect(t *testing.T) {
	tests := []struct {
		name   string
		bounds image.Rectangle
		want   image.Rectangle
	}{
		{name: "landscape", bounds: image.Rect(0, 0, 1200, 800), want: image.Rect(200, 0, 1000, 800)},
		{name: "portrait", bounds: image.Rect(0, 0, 320, 240), want: image.Rect(40, 0, 280, 240)},
		{name: "already square", bounds: image.Rect(0, 0, 512, 512), want: image.Rect(0, 0, 512, 512)},
		{name: "offset origin", bounds: image.Rect(10, 20, 110, 220), want: image.Rect(10, 70, 110, 170)},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := centerCropRect(tt.bounds); got != tt.want {
				t.Fatalf("centerCropRect(%v) = %v, want %v", tt.bounds, got, tt.want)
			}
		})
	}
}

// assertPixelGrid compares every pixel of img against want using exact 16-bit
// channel values, so an orientation mix-up cannot hide behind JPEG tolerance.
func assertPixelGrid(t *testing.T, img image.Image, want [][]color.RGBA) {
	t.Helper()

	bounds := img.Bounds()
	if bounds.Dx() != len(want[0]) || bounds.Dy() != len(want) {
		t.Fatalf("image size = %dx%d, want %dx%d", bounds.Dx(), bounds.Dy(), len(want[0]), len(want))
	}

	for y := range want {
		for x := range want[y] {
			r, g, b, a := img.At(bounds.Min.X+x, bounds.Min.Y+y).RGBA()
			w := want[y][x]
			if r != uint32(w.R)*0x101 || g != uint32(w.G)*0x101 || b != uint32(w.B)*0x101 || a != uint32(w.A)*0x101 {
				t.Fatalf("pixel (%d, %d) = (%d, %d, %d, %d), want %v", x, y, r>>8, g>>8, b>>8, a>>8, w)
			}
		}
	}
}

// gradientJPEG builds a smooth, small-on-disk JPEG fixture of an exact size.
func gradientJPEG(t *testing.T, width, height int) []byte {
	t.Helper()

	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, gradientImage(width, height), &jpeg.Options{Quality: 90}); err != nil {
		t.Fatalf("encode JPEG fixture: %v", err)
	}
	return buf.Bytes()
}

// gradientPNG builds an opaque PNG fixture of an exact size.
func gradientPNG(t *testing.T, width, height int) []byte {
	t.Helper()

	var buf bytes.Buffer
	if err := png.Encode(&buf, gradientImage(width, height)); err != nil {
		t.Fatalf("encode PNG fixture: %v", err)
	}
	return buf.Bytes()
}

// alphaHalfPNG builds a PNG whose left half is fully transparent and right half
// is opaque red, so the avatar path can be checked for white flattening.
func alphaHalfPNG(t *testing.T, width, height int) []byte {
	t.Helper()

	img := image.NewNRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			if x < width/2 {
				img.SetNRGBA(x, y, color.NRGBA{A: 0})
				continue
			}
			img.SetNRGBA(x, y, color.NRGBA{R: 255, A: 255})
		}
	}

	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode alpha PNG fixture: %v", err)
	}
	return buf.Bytes()
}

func gradientImage(width, height int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	lastX := max(width-1, 1)
	lastY := max(height-1, 1)
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			img.SetRGBA(x, y, color.RGBA{
				R: uint8(x * 255 / lastX),
				G: uint8(y * 255 / lastY),
				B: uint8((x + y) % 256),
				A: 255,
			})
		}
	}
	return img
}
