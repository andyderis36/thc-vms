package repository

import (
	"testing"
)

// searchParam is the NULL-vs-term gate the six list/count call sites share:
// blank stays SQL NULL (legacy unfiltered), a term becomes a valid ILIKE
// predicate. Filtered and unfiltered MUST differ here, or ?q= is dead again.
func TestSearchParam_FilteredVsUnfiltered(t *testing.T) {
	unfiltered := []string{"", "   ", "\t\n "}
	for _, raw := range unfiltered {
		got := searchParam(raw)
		if got.Valid {
			t.Fatalf("searchParam(%q).Valid = true, want false (NULL = unfiltered)", raw)
		}
	}

	for _, raw := range []string{"Budi", "VST-0000000001", "  Budi  "} {
		got := searchParam(raw)
		if !got.Valid {
			t.Fatalf("searchParam(%q).Valid = false, want true (filtered)", raw)
		}
	}
	if got := searchParam("  Budi  "); got.String != "Budi" {
		t.Fatalf("searchParam trims, got %q", got.String)
	}
	if a, b := searchParam("Budi"), searchParam(""); a == b {
		t.Fatalf("filtered vs unfiltered params must differ, both = %+v", a)
	}
}
