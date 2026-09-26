// Package directory backs the two role/location resolver seams the wiring
// needs: jwt.Directory (role id to name, location id to name, for token
// minting) and auth.RoleDirectory (role id to name, for the profile
// projection). Both resolve against the pool and the domain ports the
// repository package already implements; the single role-name lookup the
// ports cannot serve stays here as one indexed primary-key query on the
// pool, never as an edit to the repository package.
//
// The two seams spell LookupRole differently (jwt takes no context, auth
// takes one), so Go cannot implement both on one struct: Directory serves
// jwt.Directory and the RoleDirectory adapter serves auth.RoleDirectory over
// the same state.
package directory

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"thc-vms/backend/internal/domain"
	infraJWT "thc-vms/backend/internal/infrastructure/jwt"
	"thc-vms/backend/internal/usecase/auth"
)

// Compile-time proofs that the two types serve their seam.
var _ infraJWT.Directory = (*Directory)(nil)
var _ auth.RoleDirectory = (*RoleDirectory)(nil)

// lookupTimeout bounds the context-free jwt.Directory calls, which arrive
// without a caller context.
const lookupTimeout = 5 * time.Second

// Directory resolves role and location names for JWT minting.
type Directory struct {
	pool   *pgxpool.Pool
	master domain.MasterDataRepository
}

// New wires the directory to the pool (for the role-name query) and to the
// master-data port (for location names).
func New(pool *pgxpool.Pool, master domain.MasterDataRepository) *Directory {
	return &Directory{pool: pool, master: master}
}

// LookupRole resolves a role id to its canonical name for JWT minting. It
// carries no caller context, so it runs on a bounded background context.
func (d *Directory) LookupRole(id domain.UUID) (domain.RoleName, error) {
	ctx, cancel := context.WithTimeout(context.Background(), lookupTimeout)
	defer cancel()
	return d.roleName(ctx, id)
}

// LookupLocation resolves a location id to its display name through the
// master-data port on a bounded background context.
func (d *Directory) LookupLocation(id domain.UUID) (string, error) {
	if d.master == nil {
		return "", fmt.Errorf("directory: master-data port not configured: %w", domain.ErrNotFound)
	}
	ctx, cancel := context.WithTimeout(context.Background(), lookupTimeout)
	defer cancel()
	loc, err := d.master.FindLocationByID(ctx, id)
	if err != nil {
		return "", fmt.Errorf("directory: resolve location %q: %w", string(id), err)
	}
	return loc.Name, nil
}

// Roles exposes this directory as the auth.RoleDirectory seam for the
// profile projection.
func (d *Directory) Roles() *RoleDirectory {
	return &RoleDirectory{inner: d}
}

// RoleIDByName resolves a role name (for example "security") to its row id,
// read from the seeded role table. The composition root calls this once at
// startup for NewUserHandler.
func (d *Directory) RoleIDByName(ctx context.Context, name domain.RoleName) (domain.UUID, error) {
	if d.pool == nil {
		return "", fmt.Errorf("directory: pool not configured: %w", domain.ErrNotFound)
	}
	var id uuid.UUID
	query := `SELECT id FROM role WHERE name = $1`
	if err := d.pool.QueryRow(ctx, query, string(name)).Scan(&id); err != nil {
		return "", fmt.Errorf("directory: resolve role %q: %w", string(name), err)
	}
	if id == uuid.Nil {
		return "", fmt.Errorf("directory: role %q has no id: %w", string(name), domain.ErrNotFound)
	}
	return domain.UUID(id.String()), nil
}

// roleName runs the indexed primary-key lookup backing every role seam.
func (d *Directory) roleName(ctx context.Context, id domain.UUID) (domain.RoleName, error) {
	if d.pool == nil {
		return "", fmt.Errorf("directory: pool not configured: %w", domain.ErrNotFound)
	}
	parsed, err := uuid.Parse(string(id))
	if err != nil {
		return "", fmt.Errorf("directory: invalid role id %q: %w", string(id), domain.ErrValidation)
	}
	var name string
	query := `SELECT name FROM role WHERE id = $1`
	if err := d.pool.QueryRow(ctx, query, parsed).Scan(&name); err != nil {
		return "", fmt.Errorf("directory: resolve role %q: %w", string(id), err)
	}
	return domain.RoleName(name), nil
}

// RoleDirectory adapts a Directory to the auth.RoleDirectory seam: the same
// indexed lookup, but honouring the caller's context.
type RoleDirectory struct {
	inner *Directory
}

// LookupRole resolves a role id to its canonical name for the auth profile
// projection.
func (r *RoleDirectory) LookupRole(ctx context.Context, id domain.UUID) (domain.RoleName, error) {
	return r.inner.roleName(ctx, id)
}
