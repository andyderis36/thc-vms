package repository

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
)

// TestVisitFieldsToDomain_MapsVendorUserNameAndEmail pins the vendor enrichment: the
// users join columns ride along into the domain so the FE Informasi Kunjungan
// card renders vendor_user.name without an extra query.
func TestVisitFieldsToDomain_MapsVendorUserNameAndEmail(t *testing.T) {
	id := uuid.New()
	vendorUserID := uuid.New()
	loc := uuid.New()
	now := time.Now().UTC().Truncate(time.Second)

	got, err := visitFieldsToDomain(
		id, "VST-0000000001", vendorUserID, pgtype.UUID{Valid: false}, loc,
		now, now.Add(4*time.Hour), false, "approved",
		pgtype.Text{Valid: false}, true, pgtype.Text{Valid: false},
		pgtype.Text{Valid: false}, pgtype.Text{String: "PT Override", Valid: true},
		now, now, pgtype.Text{Valid: false},
		"POP Tebet", "pop",
		"Dimas Prasetyo", "dimas@vendor.example", "PT Akun Vendor",
	)
	if err != nil {
		t.Fatalf("visitFieldsToDomain: %v", err)
	}
	if got.VendorUserName != "Dimas Prasetyo" {
		t.Fatalf("VendorUserName = %q, want Dimas Prasetyo", got.VendorUserName)
	}
	if got.VendorUserEmail != "dimas@vendor.example" {
		t.Fatalf("VendorUserEmail = %q, want dimas@vendor.example", got.VendorUserEmail)
	}
	if got.LocationName != "POP Tebet" {
		t.Fatalf("LocationName = %q, want POP Tebet", got.LocationName)
	}
	if got.VendorNameOverride == nil || *got.VendorNameOverride != "PT Override" {
		t.Fatalf("VendorNameOverride = %v, want PT Override", got.VendorNameOverride)
	}
	if got.VendorUserVendorName != "PT Akun Vendor" {
		t.Fatalf("VendorUserVendorName = %q, want PT Akun Vendor", got.VendorUserVendorName)
	}
}
