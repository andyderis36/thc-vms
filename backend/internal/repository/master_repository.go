package repository

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
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

// Compile-time proof that the same adapter satisfies the super_admin
// facility port (read catalogue plus location writes).
var _ domain.LocationAdminRepository = (*masterRepository)(nil)

// Compile-time proof that the same adapter satisfies the vendor catalogue
// port (company list plus single-name lookup for the auth profile).
var _ domain.VendorRepository = (*masterRepository)(nil)

// NewMasterDataRepository builds the PostgreSQL-backed domain.MasterDataRepository.
func NewMasterDataRepository(pool *pgxpool.Pool) domain.MasterDataRepository {
	return &masterRepository{pool: pool}
}

// NewLocationAdminRepository exposes the same PostgreSQL adapter through the
// super_admin facility port. It is a separate constructor (rather than a
// widened NewMasterDataRepository return) so the read-only callers keep
// their narrow type and no existing signature changes.
func NewLocationAdminRepository(pool *pgxpool.Pool) domain.LocationAdminRepository {
	return &masterRepository{pool: pool}
}

// NewVendorRepository exposes the same PostgreSQL adapter through the vendor
// catalogue port (company list for forms plus name lookup for the auth
// profile), again without widening the read-only constructor.
func NewVendorRepository(pool *pgxpool.Pool) domain.VendorRepository {
	return &masterRepository{pool: pool}
}

// ListLocations serves the facility catalogue. onlyActive=true (the default
// behind GET /locations) returns operating facilities via
// ListActiveLocations for the SCR-03 pickers; onlyActive=false returns every
// row with its real is_active flag via ListAllLocations so the super_admin
// console can show and reactivate switched-off branches.
func (r *masterRepository) ListLocations(ctx context.Context, onlyActive bool) ([]domain.Location, error) {
	if !onlyActive {
		rows, err := db.New(r.pool).ListAllLocations(ctx)
		if err != nil {
			return nil, MapError(err)
		}
		out := make([]domain.Location, 0, len(rows))
		for _, row := range rows {
			out = append(out, locationModelToDomain(row))
		}
		return out, nil
	}
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

// FindLocationByID resolves one facility by primary key, carrying its real
// is_active flag (the generated projection selects the column).
func (r *masterRepository) FindLocationByID(ctx context.Context, id domain.UUID) (domain.Location, error) {
	parsed, err := fromDomainUUID(id)
	if err != nil {
		return domain.Location{}, err
	}
	row, err := db.New(r.pool).GetLocationByID(ctx, db.GetLocationByIDParams{ID: parsed})
	if err != nil {
		return domain.Location{}, MapError(err)
	}
	return locationModelToDomain(row), nil
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

// ListVendors serves the company dropdown behind GET /vendors: every
// non-blacklisted partner company, ordered by name. The predicate guarantees
// IsActive on every returned row, mirroring ListPurposes.
func (r *masterRepository) ListVendors(ctx context.Context) ([]domain.Vendor, error) {
	rows, err := db.New(r.pool).ListActiveVendors(ctx)
	if err != nil {
		return nil, MapError(err)
	}
	out := make([]domain.Vendor, 0, len(rows))
	for _, row := range rows {
		out = append(out, domain.Vendor{
			ID:   mustDomainUUID(row.ID),
			Name: row.Name,
		})
	}
	return out, nil
}

// FindVendorName resolves one company display name for the auth profile. A
// missing id surfaces domain.ErrNotFound through MapError's pgx.ErrNoRows
// mapping; profile callers treat that as an unnamed vendor.
func (r *masterRepository) FindVendorName(ctx context.Context, id domain.UUID) (string, error) {
	parsed, err := fromDomainUUID(id)
	if err != nil {
		return "", err
	}
	name, err := db.New(r.pool).GetVendorName(ctx, db.GetVendorNameParams{ID: parsed})
	if err != nil {
		return "", MapError(err)
	}
	return name, nil
}

// CreateLocation persists one facility for POST /locations. An empty address
// or city is stored as SQL NULL so the read projection renders "" either
// way; the CHECK constraints on type/timezone are the second line of defence
// behind the usecase validation (23514 -> ErrValidation via MapError).
func (r *masterRepository) CreateLocation(ctx context.Context, loc domain.Location) (domain.Location, error) {
	row, err := db.New(r.pool).InsertLocation(ctx, db.InsertLocationParams{
		Name:     loc.Name,
		Type:     string(loc.Type),
		Address:  blankToNullText(loc.Address),
		City:     blankToNullText(loc.City),
		Timezone: string(loc.Timezone),
	})
	if err != nil {
		return domain.Location{}, MapError(err)
	}
	return locationModelToDomain(row), nil
}

// UpdateLocation applies the partial patch of PATCH /locations/:id. A nil
// patch member becomes SQL NULL so COALESCE keeps the stored column; an
// unknown id surfaces domain.ErrNotFound through MapError's pgx.ErrNoRows
// mapping, which the handler renders as 404.
func (r *masterRepository) UpdateLocation(ctx context.Context, id domain.UUID, patch domain.LocationPatch) (domain.Location, error) {
	parsed, err := fromDomainUUID(id)
	if err != nil {
		return domain.Location{}, err
	}
	row, err := db.New(r.pool).UpdateLocation(ctx, db.UpdateLocationParams{
		ID:       parsed,
		Name:     patchMemberText(patch.Name),
		Type:     patchLocationTypeText(patch.Type),
		Address:  patchMemberText(patch.Address),
		City:     patchMemberText(patch.City),
		Timezone: patchTimezoneText(patch.Timezone),
		IsActive: patchBool(patch.IsActive),
	})
	if err != nil {
		return domain.Location{}, MapError(err)
	}
	return locationModelToDomain(row), nil
}

// locationModelToDomain projects the generated location model (whose
// RETURNING shape carries every column including is_active) onto the domain
// entity. Unlike the catalogue reads there is no KNOWN GAP here: IsActive is
// carried verbatim.
func locationModelToDomain(row db.Location) domain.Location {
	return domain.Location{
		ID:       mustDomainUUID(row.ID),
		Name:     row.Name,
		Type:     domain.LocationType(row.Type),
		Address:  textValue(row.Address),
		City:     textValue(row.City),
		Timezone: domain.Timezone(row.Timezone),
		IsActive: row.IsActive,
	}
}

// blankToNullText stores an all-whitespace string as SQL NULL instead of an
// empty row value; the read projection renders NULL as "" either way.
func blankToNullText(s string) pgtype.Text {
	if strings.TrimSpace(s) == "" {
		return pgtype.Text{Valid: false}
	}
	return pgtype.Text{String: s, Valid: true}
}

// patchMemberText maps one optional patch member to its bound value: nil (or
// blank, which validation never produces for the constrained members) means
// SQL NULL so COALESCE keeps the stored column.
func patchMemberText(s *string) pgtype.Text {
	if s == nil {
		return pgtype.Text{Valid: false}
	}
	return blankToNullText(*s)
}

// patchLocationTypeText maps the optional type member the same way.
func patchLocationTypeText(t *domain.LocationType) pgtype.Text {
	if t == nil {
		return pgtype.Text{Valid: false}
	}
	return pgtype.Text{String: string(*t), Valid: true}
}

// patchTimezoneText maps the optional timezone member the same way.
func patchTimezoneText(t *domain.Timezone) pgtype.Text {
	if t == nil {
		return pgtype.Text{Valid: false}
	}
	return pgtype.Text{String: string(*t), Valid: true}
}

// patchBool maps the optional is_active member: nil keeps the stored flag.
func patchBool(b *bool) pgtype.Bool {
	if b == nil {
		return pgtype.Bool{Valid: false}
	}
	return pgtype.Bool{Bool: *b, Valid: true}
}
