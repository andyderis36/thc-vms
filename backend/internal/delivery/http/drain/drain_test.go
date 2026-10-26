package drain

import (
	"errors"
	"io"
	"strings"
	"testing"
)

func TestBoundedConsumesWholeShortBody(t *testing.T) {
	body := strings.NewReader("0123456789")

	if got := Bounded(body, 1024); got != 10 {
		t.Fatalf("Bounded = %d, want 10", got)
	}
	if body.Len() != 0 {
		t.Fatalf("sisa %d byte, want 0", body.Len())
	}
}

func TestBoundedStopsAtLimit(t *testing.T) {
	body := strings.NewReader(strings.Repeat("x", 5000))

	if got := Bounded(body, 1024); got != 1024 {
		t.Fatalf("Bounded = %d, want 1024", got)
	}
	if body.Len() != 5000-1024 {
		t.Fatalf("sisa %d byte, want %d", body.Len(), 5000-1024)
	}
}

func TestBoundedIgnoresNilAndNonPositiveLimit(t *testing.T) {
	if got := Bounded(nil, 10); got != 0 {
		t.Fatalf("Bounded(nil) = %d, want 0", got)
	}

	body := strings.NewReader("abc")
	if got := Bounded(body, 0); got != 0 {
		t.Fatalf("Bounded(limit=0) = %d, want 0", got)
	}
	if body.Len() != 3 {
		t.Fatalf("limit 0 tetap mengonsumsi body: sisa %d, want 3", body.Len())
	}
}

func TestBoundedSwallowsReadError(t *testing.T) {
	body := io.MultiReader(strings.NewReader("abcd"), errReader{})

	if got := Bounded(body, 1024); got != 4 {
		t.Fatalf("Bounded = %d, want 4", got)
	}
}

type errReader struct{}

func (errReader) Read([]byte) (int, error) { return 0, errors.New("boom") }
