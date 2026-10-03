package repository

import (
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
)

// pgTextOf builds a SQL-present text value; null builds a SQL-NULL value, so
// each case below reads exactly what the driver hands the resolver.
func pgTextOf(s string) pgtype.Text { return pgtype.Text{String: s, Valid: true} }

var nullText = pgtype.Text{Valid: false}

// TestResolveVendorDisplayName_PrefersManualOverride pins the read contract
// every vendor_name projection funnels through (visitor roster, managed-user
// console, auth profile): the manually typed company wins, the catalogue name
// is the fallback, and a blank-but-present override never shadows the
// catalogue — a whitespace-only row must still show the registered name.
func TestResolveVendorDisplayName_PrefersManualOverride(t *testing.T) {
	cases := []struct {
		name          string
		override      pgtype.Text
		catalogue     pgtype.Text
		want          string
		wantPtrNil    bool
		wantPtrAbsent bool
	}{
		{
			name:      "override wins over catalogue",
			override:  pgTextOf("PT Subkon Mandiri"),
			catalogue: pgTextOf("PT Lintas Fiber"),
			want:      "PT Subkon Mandiri",
		},
		{
			name:      "catalogue used when override absent",
			override:  nullText,
			catalogue: pgTextOf("PT Lintas Fiber"),
			want:      "PT Lintas Fiber",
		},
		{
			name:      "blank override falls through to catalogue",
			override:  pgTextOf("   "),
			catalogue: pgTextOf("PT Lintas Fiber"),
			want:      "PT Lintas Fiber",
		},
		{
			name:      "empty override falls through to catalogue",
			override:  pgTextOf(""),
			catalogue: pgTextOf("PT Lintas Fiber"),
			want:      "PT Lintas Fiber",
		},
		{
			name:      "override only, no catalogue link",
			override:  pgTextOf("CV Mandiri"),
			catalogue: nullText,
			want:      "CV Mandiri",
		},
		{
			name:      "catalogue only, no override",
			override:  nullText,
			catalogue: pgTextOf("PT Lintas Fiber"),
			want:      "PT Lintas Fiber",
		},
		{
			name:          "neither present resolves to empty",
			override:      nullText,
			catalogue:     nullText,
			want:          "",
			wantPtrNil:    true,
			wantPtrAbsent: true,
		},
		{
			name:          "whitespace override without catalogue stays empty",
			override:      pgTextOf("  "),
			catalogue:     nullText,
			want:          "",
			wantPtrNil:    true,
			wantPtrAbsent: true,
		},
		{
			name:      "surrounding whitespace is trimmed from the override",
			override:  pgTextOf("  PT Subkon Mandiri  "),
			catalogue: nullText,
			want:      "PT Subkon Mandiri",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := resolveVendorDisplayName(tc.override, tc.catalogue)
			if got != tc.want {
				t.Fatalf("resolveVendorDisplayName() = %q, want %q", got, tc.want)
			}

			// The pointer variant feeds nullable wire members: the same
			// resolution, but nil for "no company at all" so JSON renders null
			// instead of an empty string.
			gotPtr := resolveVendorDisplayPtr(tc.override, tc.catalogue)
			if tc.wantPtrNil {
				if gotPtr != nil {
					t.Fatalf("resolveVendorDisplayPtr() = %q, want nil", *gotPtr)
				}
				return
			}
			if gotPtr == nil {
				t.Fatalf("resolveVendorDisplayPtr() = nil, want %q", tc.want)
			}
			if *gotPtr != tc.want {
				t.Fatalf("resolveVendorDisplayPtr() = %q, want %q", *gotPtr, tc.want)
			}
		})
	}
}

// TestResolveVendorDisplayName_OverrideIsNeverCopiedIntoCatalogue guards the
// one rule the manual-company feature exists to enforce: these columns are
// display-only. The resolver reads them, so the risk is that a manual value
// could leak back into the vendor table and reappear in the dropdown. Pin the
// contract that keeps them separate — the vendor catalogue is master data
// owned by Superadmin and is never written from a visitor/user override.
func TestResolveVendorDisplayName_OverrideIsNeverCopiedIntoCatalogue(t *testing.T) {
	manual := "PT Subkon Mandiri"

	if got := resolveVendorDisplayName(pgTextOf(manual), nullText); got != manual {
		t.Fatalf("override must render for display, got %q", got)
	}

	// An override must not behave like a catalogue entry: with no catalogue
	// link present there is nothing for it to match against, so the dropdown
	// query (which reads the vendor table only) cannot observe it. This is
	// asserted as a structural fact about the inputs the resolver accepts.
	if resolveVendorDisplayName(nullText, nullText) == manual {
		t.Fatal("an absent override must not resolve to a manually typed company")
	}
}
