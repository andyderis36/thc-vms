package handlers

import (
	"context"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	deliveryhttp "thc-vms/backend/internal/delivery/http"
	"thc-vms/backend/internal/delivery/http/response"
	"thc-vms/backend/internal/domain"
)

// MasterHandler serves the catalogues the visit form consumes:
// GET /locations and GET /purposes. Purposes always return active rows
// only; locations default to active-only but honour ?active_only=false for
// the super_admin console. Every location row carries its is_active flag.
type MasterHandler struct {
	master domain.MasterDataRepository
}

// NewMasterHandler wires the handler to the master-data port.
func NewMasterHandler(master domain.MasterDataRepository) *MasterHandler {
	return &MasterHandler{master: master}
}

// masterLocationDTO mirrors the openapi Location schema plus the is_active
// flag the super_admin console renders: id, name, type
// (pusat|cabang|pop|minipop), address, city, timezone (WIB|WITA|WIT),
// is_active. (The openapi.yaml text is owned by the FE agent; the contract
// pin in contract_test.go carries the same key so the subset assertion
// stays green.)
type masterLocationDTO struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Type     string `json:"type"`
	Address  string `json:"address"`
	City     string `json:"city"`
	Timezone string `json:"timezone"`
	IsActive bool   `json:"is_active"`
}

// masterPurposeDTO mirrors the openapi Purpose schema exactly: id and name.
type masterPurposeDTO struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// masterVendorDTO is the [{id, name}] company dropdown the vendor/admin forms
// consume: the vendor identity plus its display name, nothing else.
type masterVendorDTO struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// ListLocations serves GET /locations with the facility catalogue. The
// ?active_only= query defaults to TRUE (backward compatible: the SCR-03
// visit form keeps receiving the active-only catalogue); active_only=false
// lists every row including deactivated ones so the super_admin console can
// show and reactivate them. An unparseable value is 400.
func (h *MasterHandler) ListLocations(c *gin.Context) {
	if _, ok := deliveryhttp.IdentityFrom(c); !ok {
		response.Fail(c, domain.ErrUnauthorized)
		return
	}
	activeOnly := true
	if raw := strings.TrimSpace(c.Query("active_only")); raw != "" {
		parsed, err := strconv.ParseBool(raw)
		if err != nil {
			response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "active_only harus true atau false.")
			return
		}
		activeOnly = parsed
	}
	locations, err := h.master.ListLocations(c.Request.Context(), activeOnly)
	if err != nil {
		response.Fail(c, err)
		return
	}
	out := make([]masterLocationDTO, 0, len(locations))
	for _, loc := range locations {
		out = append(out, masterLocationDTO{
			ID:       string(loc.ID),
			Name:     loc.Name,
			Type:     string(loc.Type),
			Address:  loc.Address,
			City:     loc.City,
			Timezone: string(loc.Timezone),
			IsActive: loc.IsActive,
		})
	}
	response.OK(c, out)
}

// ListPurposes serves GET /purposes with the active visit-reason catalogue.
func (h *MasterHandler) ListPurposes(c *gin.Context) {
	if _, ok := deliveryhttp.IdentityFrom(c); !ok {
		response.Fail(c, domain.ErrUnauthorized)
		return
	}
	purposes, err := h.master.ListPurposes(c.Request.Context(), true)
	if err != nil {
		response.Fail(c, err)
		return
	}
	out := make([]masterPurposeDTO, 0, len(purposes))
	for _, p := range purposes {
		out = append(out, masterPurposeDTO{ID: string(p.ID), Name: p.Name})
	}
	response.OK(c, out)
}

// vendorCatalogue is the narrow seam ListVendors needs beyond the read-only
// master-data port. The production adapter satisfies it through
// domain.VendorRepository; a narrow fake fails closed with 500 instead of
// panicking, mirroring the securityDeleteStore pattern.
type vendorCatalogue interface {
	ListVendors(ctx context.Context) ([]domain.Vendor, error)
}

// ListVendors serves GET /vendors with the active company catalogue. Every
// authenticated role may read it (the FE company dropdown is shared by the
// vendor application form and the admin consoles); blacklisted companies are
// never offered.
func (h *MasterHandler) ListVendors(c *gin.Context) {
	if _, ok := deliveryhttp.IdentityFrom(c); !ok {
		response.Fail(c, domain.ErrUnauthorized)
		return
	}
	catalogue, ok := h.master.(vendorCatalogue)
	if !ok {
		response.Fail(c, domain.ErrDatabase)
		return
	}
	vendors, err := catalogue.ListVendors(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	out := make([]masterVendorDTO, 0, len(vendors))
	for _, v := range vendors {
		out = append(out, masterVendorDTO{ID: string(v.ID), Name: v.Name})
	}
	response.OK(c, out)
}
