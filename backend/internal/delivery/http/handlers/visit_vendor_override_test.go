package handlers_test

// HTTP seam of the visit-level vendor/mitra override (migration 000017).
// The usecase suite (internal/usecase/visit/visit_vendor_override_test.go)
// owns the trimming, cap and persistence rules; this file pins what the wire
// must do: map the top-level vendor_name body member onto the usecase input,
// render override-wins-otherwise-catalogue on the created detail, carry the
// requesting account's company on vendor_user.vendor_name, and refuse the
// over-long case BEFORE the usecase is ever called.

import (
	"net/http"
	"strings"
	"testing"

	"thc-vms/backend/internal/domain"
)

// overrideVisitPayload builds a POST /visits body carrying the visit-level
// vendor_name member under test alongside the purpose field.
func overrideVisitPayload(purposeField, vendorField string) string {
	return `{
		"location_id": "` + manualLocUUID + `",
		` + purposeField + `
		` + vendorField + `
		"start_date": "2026-10-01T09:00:00Z",
		"end_date": "2026-10-01T17:00:00Z",
		"is_nda_accepted": true,
		"assignment_letter_url": "http://localhost:9000/thc-vms-bucket/assignment_letters/visit-1/spk.pdf",
		"visitors": [{"name": "Andi", "id_number": "ID12345678", "phone": "081234567890"}]
	}`
}

// TestCreateVisit_MapsVisitLevelVendorName proves the top-level vendor_name
// member reaches the usecase input verbatim (trimming happens there) and the
// 201 detail renders it over the catalogue name.
func TestCreateVisit_MapsVisitLevelVendorName(t *testing.T) {
	override := "PT Kunjungan Mandiri"
	created := cannedVisit() // catalogue VendorName "PT Lintas Fiber"
	created.VendorNameOverride = &override
	created.VendorUserVendorName = "PT Akun Vendor"
	svc := &fakeVisitService{created: created}
	engine := newVisitEngine(svc, domain.RoleAdmin, "loc-A")

	payload := overrideVisitPayload(`"purpose_ids": ["`+manualCatUUID+`"],`,
		`"vendor_name": "  `+override+`  ",`)
	rec := serveJSON(engine, "POST", "/visits", payload)
	mustStatus(t, rec, http.StatusCreated)

	if svc.lastCreateIn.VendorName == nil || *svc.lastCreateIn.VendorName != "  "+override+"  " {
		t.Fatalf("visit-level vendor_name not mapped onto the usecase input: %+v", svc.lastCreateIn.VendorName)
	}

	detail := asObject(t, mustSuccess(t, rec).Data)
	if detail["vendor_name"] != override {
		t.Fatalf("wire vendor_name = %v, want the trimmed override over the catalogue name", detail["vendor_name"])
	}
	vendorUser, ok := detail["vendor_user"].(map[string]any)
	if !ok {
		t.Fatalf("vendor_user missing: %v", detail["vendor_user"])
	}
	if vendorUser["vendor_name"] != "PT Akun Vendor" {
		t.Fatalf("vendor_user.vendor_name = %v, want the requesting account company", vendorUser["vendor_name"])
	}
	if vendorUser["name"] != "Dimas Prasetyo" {
		t.Fatalf("vendor_user.name = %v, want the account holder name, not the company", vendorUser["name"])
	}
}

// TestVisitDetail_VendorNameFallsBackToCatalogue proves the catalogue display
// survives when no visit-level override travels along, and that a company-less
// account omits vendor_user.vendor_name instead of rendering "".
func TestVisitDetail_VendorNameFallsBackToCatalogue(t *testing.T) {
	created := cannedVisit() // no override, no account company
	svc := &fakeVisitService{created: created}
	engine := newVisitEngine(svc, domain.RoleVendor, "")

	rec := serveJSON(engine, "POST", "/visits", overrideVisitPayload(`"purpose_ids": ["`+manualCatUUID+`"],`, ""))
	mustStatus(t, rec, http.StatusCreated)

	detail := asObject(t, mustSuccess(t, rec).Data)
	if detail["vendor_name"] != "PT Lintas Fiber" {
		t.Fatalf("wire vendor_name = %v, want the catalogue name without an override", detail["vendor_name"])
	}
	vendorUser, ok := detail["vendor_user"].(map[string]any)
	if !ok {
		t.Fatalf("vendor_user missing: %v", detail["vendor_user"])
	}
	if _, present := vendorUser["vendor_name"]; present {
		t.Fatalf("vendor_user.vendor_name = %v, want the key omitted without an account company", vendorUser["vendor_name"])
	}
}

// TestCreateVisit_RejectsOverlongVisitLevelVendorName is the negative half:
// a 121-rune visit-level company is 400 VALIDATION_ERROR and never reaches
// the usecase.
func TestCreateVisit_RejectsOverlongVisitLevelVendorName(t *testing.T) {
	svc := &fakeVisitService{}
	engine := newVisitEngine(svc, domain.RoleAdmin, "loc-A")

	payload := overrideVisitPayload(`"purpose_ids": ["`+manualCatUUID+`"],`,
		`"vendor_name": "`+strings.Repeat("A", 121)+`",`)
	rec := serveJSON(engine, "POST", "/visits", payload)
	mustStatus(t, rec, http.StatusBadRequest)

	if svc.lastCreateIn.LocationID != "" {
		t.Fatalf("a rejected body must never reach the usecase: %+v", svc.lastCreateIn)
	}
}
