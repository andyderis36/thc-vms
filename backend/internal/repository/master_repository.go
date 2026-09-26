package repository

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/repository/db"
)

// masterRepository is the PostgreSQL adapter for domain.MasterDataRepository.
// Both catalogue endpoints are read-only in the MVP: rows are written by the
// seeds program, and this adapter only serves the SCR-03 pickers.
type masterRepository struct {
	pool *pgxpool.Pool
}

// Compile-time proof that the adapter satisfies its port.
var _ domain.MasterDataRepository = (*masterRepository)(nil)

// NewMasterDataRepository builds the PostgreSQL-backed domain.MasterDataRepository.
func NewMasterDataRepository(pool *pgxpool.Pool) domain.MasterDataRepository {
	return &masterRepository{pool: pool}
}

// ListLocations serves the facility picker.
//
// KNOWN GAP (generated shape vs port): the only generated location query is
// ListActiveLocations, so onlyActive=false still returns the active catalogue;
// there is no ListAllLocations query to serve the inactive rows. The flag is
// accepted so the signature stays total, and the gap is reported rather than
// patched with hand-written SQL.
func (r *masterRepository) ListLocations(ctx context.Context, _ bool) ([]domain.Location, error) {
	rows, err := db.New(r.pool).ListActiveLocations(ctx)
	if err != nil {
		return nil, MapError(err)
	}
	out := make([]domain.Location, 0, len(rows))
	for _, row := range rows {
		out = append(out, domain.Location{
			ID:       mustDomainUUID(row.ID),
			Name:     row.Name,
			Type:     domain.LocationType(row.Type),
			Address:  textValue(row.Address),
			City:     textValue(row.City),
			Timezone: domain.Timezone(row.Timezone),
			IsActive: true,
		})
	}
	return out, nil
}

// FindLocationByID resolves one facility by primary key.
//
// KNOWN GAP (generated shape vs port): GetLocationByID projects no is_active
// column, so IsActive is reported true. Adding is_active to that SELECT would
// close the gap without touching Go code.
func (r *masterRepository) FindLocationByID(ctx context.Context, id domain.UUID) (domain.Location, error) {
	parsed, err := fromDomainUUID(id)
	if err != nil {
		return domain.Location{}, err
	}
	row, err := db.New(r.pool).GetLocationByID(ctx, db.GetLocationByIDParams{ID: parsed})
	if err != nil {
		return domain.Location{}, MapError(err)
	}
	return domain.Location{
		ID:       mustDomainUUID(row.ID),
		Name:     row.Name,
		Type:     domain.LocationType(row.Type),
		Address:  textValue(row.Address),
		City:     textValue(row.City),
		Timezone: domain.Timezone(row.Timezone),
		IsActive: true,
	}, nil
}

// ListPurposes serves the visit-reason picker.
//
// KNOWN GAP (generated shape vs port): same as ListLocations — only
// ListActivePurposes exists, so onlyActive=false still returns the active
// catalogue. The predicate guarantees IsActive=true on every returned row.
func (r *masterRepository) ListPurposes(ctx context.Context, _ bool) ([]domain.Purpose, error) {
	rows, err := db.New(r.pool).ListActivePurposes(ctx)
	if err != nil {
		return nil, MapError(err)
	}
	out := make([]domain.Purpose, 0, len(rows))
	for _, row := range rows {
		out = append(out, domain.Purpose{
			ID:       mustDomainUUID(row.ID),
			Name:     row.Name,
			IsActive: true,
		})
	}
	return out, nil
}
