package handlers

import (
	"github.com/gin-gonic/gin"

	deliveryhttp "thc-vms/backend/internal/delivery/http"
	"thc-vms/backend/internal/delivery/http/response"
	"thc-vms/backend/internal/domain"
)

// MasterHandler serves the read-only catalogues the visit form consumes:
// GET /locations and GET /purposes. Both lists return active rows only,
// matching the "daftar fasilitas aktif" contract.
type MasterHandler struct {
	master domain.MasterDataRepository
}

// NewMasterHandler wires the handler to the master-data port.
func NewMasterHandler(master domain.MasterDataRepository) *MasterHandler {
	return &MasterHandler{master: master}
}

// masterLocationDTO mirrors the openapi Location schema exactly: id, name,
// type (pusat|cabang|pop|minipop), address, city, timezone (WIB|WITA|WIT).
type masterLocationDTO struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Type     string `json:"type"`
	Address  string `json:"address"`
	City     string `json:"city"`
	Timezone string `json:"timezone"`
}

// masterPurposeDTO mirrors the openapi Purpose schema exactly: id and name.
type masterPurposeDTO struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// ListLocations serves GET /locations with the active facility catalogue.
func (h *MasterHandler) ListLocations(c *gin.Context) {
	if _, ok := deliveryhttp.IdentityFrom(c); !ok {
		response.Fail(c, domain.ErrUnauthorized)
		return
	}
	locations, err := h.master.ListLocations(c.Request.Context(), true)
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
