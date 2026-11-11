package repository

// Enriched lifecycle email context: the after-commit fan-out must render the
// resolved company, the visit-purpose catalogue, the free-typed purpose note
// and the visit notes — the same context the single-GET read serves — plus the
// team row where each member carries its own company.

import (
	"strings"
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
)

// TestEmailEnqueue_ApprovedCarriesRichContext proves UpdateStatus captures the
// locked row's company/purpose/notes context and the attached purpose rows
// inside the transaction, and that the fanned-out email renders them.
func TestEmailEnqueue_ApprovedCarriesRichContext(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	fx := seedEmailFixture(t, pool)
	fake := &domain.FakeMailer{}
	repos := NewVisitRepository(pool).WithMailer(fake)

	catalogue := seedVendor(t, pool, "PT Katalog Cipta")
	start := time.Now().UTC().Add(24 * time.Hour).Truncate(time.Second)
	visitID := seedVisit(t, pool, seedVisitParams{
		Code: "VST-0000000333", VendorUser: fx.vendor, Vendor: catalogue, Location: fx.loc,
		Start: start, End: start.Add(4 * time.Hour), Status: domain.VisitStatusRequested, CreatedBy: fx.vendor,
	})
	if _, err := pool.Exec(ctx,
		`UPDATE visit_request SET notes = $2, purpose_note = $3, vendor_name_override = $4 WHERE id = $1`,
		uuidArg(visitID), "Bawa alat ukur", "Cek backbone", "PT Override Karya"); err != nil {
		t.Fatalf("enrich visit row: %v", err)
	}
	linkPurpose(t, pool, visitID, seedPurpose(t, pool, "Maintenance Genset"))
	linkPurpose(t, pool, visitID, seedPurpose(t, pool, "Splicing FO"))
	seedVisitorRow(t, pool, visitID, "Andi", "ID-CTX-1", "")
	if _, err := pool.Exec(ctx,
		`INSERT INTO visitor (visit_request_id, name, id_number, phone, vendor_name_override)
		 VALUES ($1, $2, $3, $4, $5)`,
		uuidArg(visitID), "Budi", "ID-CTX-2", "0811000001", "PT Sub Mitra"); err != nil {
		t.Fatalf("seed member with company: %v", err)
	}

	if err := repos.UpdateStatus(ctx, visitID, domain.VisitStatusApproved, fx.admin, "disetujui"); err != nil {
		t.Fatalf("UpdateStatus approved: %v", err)
	}
	call := assertToSet(t, fake, []string{fx.vendorEmail})

	textWants := []string{
		"Vendor/Perusahaan: PT Override Karya",
		"Keperluan: Maintenance Genset, Splicing FO",
		"Keperluan lain: Cek backbone",
		"Catatan: Bawa alat ukur",
		"Anggota tim: Andi, Budi (PT Sub Mitra)",
	}
	for _, want := range textWants {
		if !strings.Contains(call.TextBody, want) {
			t.Errorf("text body missing %q:\n%s", want, call.TextBody)
		}
	}
	if strings.Contains(call.TextBody, "PT Katalog Cipta") {
		t.Errorf("the visit-level override must win over the catalogue company:\n%s", call.TextBody)
	}

	htmlWants := []string{
		"Vendor/Perusahaan", "PT Override Karya",
		"Keperluan", "Maintenance Genset, Splicing FO",
		"Keperluan lain", "Cek backbone",
		"Catatan", "Bawa alat ukur",
		"Budi (PT Sub Mitra)",
	}
	for _, want := range htmlWants {
		if !strings.Contains(call.HTMLBody, want) {
			t.Errorf("HTML body missing %q", want)
		}
	}
}
