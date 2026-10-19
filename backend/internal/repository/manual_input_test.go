package repository

// Round-trip suite for the manual company / free-typed purpose columns added by
// migration 000005. The unit tests above prove the Go-side resolution rules;
// these prove the values actually SURVIVE PostgreSQL — a NULL column, a trimmed
// string and an empty string are three different outcomes in the wire contract,
// and only a real round trip distinguishes them.
//
// Two invariants carry the feature and are therefore pinned here rather than
// only in the usecase tests:
//   - a manual per-technician company never becomes catalogue master data
//     (the vendor table must not grow), and
//   - the manual company and the free-typed purpose note never surface on the
//     VISIT itself, because a visit names no single company.

import (
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
)

// TestManualInput_RoundTripsThroughPostgreSQL writes a manual company on one
// visitor, a free-typed purpose note on the visit, and a catalogue vendor on a
// second visitor, then reads everything back through FindByID.
func TestManualInput_RoundTripsThroughPostgreSQL(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	visits := NewVisitRepository(pool)
	vendors := NewVendorRepository(pool)

	loc := seedLocation(t, pool, "Cabang Manual", "cabang")
	vendor := seedUser(t, pool, seedUserParams{
		Name: "Vendor Manual", Email: "manual@vendor.test", Role: "vendor", Type: "external",
	})
	catalogue := seedVendor(t, pool, "PT Vendor Katalog")

	start := time.Now().UTC().Add(24 * time.Hour).Truncate(time.Second)
	company := "PT Subkon Mandiri"
	freeNote := "Splicing FO sisi servers, koordinator belum ada"
	created, err := visits.Create(ctx, domain.VisitRequest{
		VendorUserID: vendor,
		LocationID:   loc,
		StartDate:    start,
		EndDate:      start.Add(4 * time.Hour),
		PurposeNote:  &freeNote,
	}, []domain.Visitor{
		{Name: "Budi Manual", IDNumber: "ID-M1", Phone: "0811", VendorNameOverride: &company},
		{Name: "Sari Katalog", IDNumber: "ID-M2", Phone: "0812", VendorID: catalogue},
	}, nil)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	got, err := visits.FindByID(ctx, created.ID)
	if err != nil {
		t.Fatalf("FindByID: %v", err)
	}

	// 1. The free-typed purpose note survives as a real string, and it did NOT
	//    become a catalogue purpose row: no purpose_ids were sent, so the join
	//    table stays empty and the note lives only on the visit.
	if got.PurposeNote == nil {
		t.Fatal("PurposeNote is nil, want the typed note back")
	}
	if *got.PurposeNote != freeNote {
		t.Errorf("PurposeNote = %q, want %q", *got.PurposeNote, freeNote)
	}
	if got.Purposes == nil {
		t.Error("Purposes is nil, want a non-nil empty slice so the wire renders []")
	}
	if len(got.Purposes) != 0 {
		t.Errorf("purposes = %d, want 0: a typed note must never join the catalogue",
			len(got.Purposes))
	}

	// 2. Both visitors come back, each with its own vendor story.
	if len(got.Visitors) != 2 {
		t.Fatalf("visitors = %d, want 2", len(got.Visitors))
	}
	byID := make(map[string]domain.Visitor, len(got.Visitors))
	for _, v := range got.Visitors {
		byID[v.IDNumber] = v
	}

	manual := byID["ID-M1"]
	if manual.VendorNameOverride == nil {
		t.Fatal("manual visitor VendorNameOverride is nil, want the typed company")
	}
	if *manual.VendorNameOverride != company {
		t.Errorf("manual visitor VendorNameOverride = %q, want %q",
			*manual.VendorNameOverride, company)
	}
	if manual.VendorName != company {
		t.Errorf("manual visitor VendorName = %q, want the override to win as display name",
			manual.VendorName)
	}
	if manual.VendorID != "" {
		t.Errorf("manual visitor VendorID = %q, want empty: manual input links no catalogue row",
			manual.VendorID)
	}

	linked := byID["ID-M2"]
	if linked.VendorID != catalogue {
		t.Errorf("linked visitor VendorID = %q, want %q", linked.VendorID, catalogue)
	}
	if linked.VendorNameOverride != nil {
		t.Errorf("linked visitor VendorNameOverride = %q, want nil: a catalogue link never stores manual text",
			*linked.VendorNameOverride)
	}
	if linked.VendorName != "PT Vendor Katalog" {
		t.Errorf("linked visitor VendorName = %q, want the catalogue name", linked.VendorName)
	}

	// 3. The manual company never leaked into catalogue master data. The vendor
	//    table must still hold exactly the one seeded row.
	catalogueList, err := vendors.ListVendors(ctx)
	if err != nil {
		t.Fatalf("List vendors: %v", err)
	}
	if len(catalogueList) != 1 {
		t.Fatalf("vendor catalogue = %d rows, want 1: a manual company must never create master data",
			len(catalogueList))
	}
	if catalogueList[0].ID != catalogue || catalogueList[0].Name != "PT Vendor Katalog" {
		t.Errorf("catalogue = %+v, want only the seeded vendor", catalogueList[0])
	}
}

// TestManualInput_NullColumnsRoundTripAsNil pins the NULL case: a visit with no
// free-typed note and visitors with no manual company must come back with nil
// pointers, NOT empty strings. That distinction is what lets the wire render
// JSON null and lets the UI show "pilih dari katalog" instead of an empty field
// the officer thinks is filled.
func TestManualInput_NullColumnsRoundTripAsNil(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	visits := NewVisitRepository(pool)

	loc := seedLocation(t, pool, "Cabang Kosong", "cabang")
	vendor := seedUser(t, pool, seedUserParams{
		Name: "Vendor Kosong", Email: "kosong@vendor.test", Role: "vendor", Type: "external",
	})
	purpose := seedPurpose(t, pool, "Troubleshoot FO")

	start := time.Now().UTC().Add(24 * time.Hour).Truncate(time.Second)
	created, err := visits.Create(ctx, domain.VisitRequest{
		VendorUserID: vendor,
		LocationID:   loc,
		StartDate:    start,
		EndDate:      start.Add(2 * time.Hour),
		// PurposeNote deliberately absent: the catalogue path only.
	}, []domain.Visitor{{Name: "Tanpa Vendor", IDNumber: "ID-N1", Phone: "0813"}},
		[]domain.UUID{purpose})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	got, err := visits.FindByID(ctx, created.ID)
	if err != nil {
		t.Fatalf("FindByID: %v", err)
	}
	if got.PurposeNote != nil {
		t.Errorf("PurposeNote = %q, want nil for a catalogue-only visit", *got.PurposeNote)
	}
	if len(got.Visitors) != 1 {
		t.Fatalf("visitors = %d, want 1", len(got.Visitors))
	}
	if got.Visitors[0].VendorNameOverride != nil {
		t.Errorf("VendorNameOverride = %q, want nil when no company was typed",
			*got.Visitors[0].VendorNameOverride)
	}
	// The catalogue purpose still attaches: manual input is an ADDITIVE path,
	// it must not disable the existing dropdown.
	if len(got.Purposes) != 1 || got.Purposes[0].ID != purpose {
		t.Errorf("purposes = %+v, want the one seeded catalogue purpose", got.Purposes)
	}
}
