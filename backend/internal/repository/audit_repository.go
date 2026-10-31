package repository

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/repository/db"
)

// This file owns the HYBRID audit writer: the standalone adapter plus the
// same-transaction audited mutations.
//
// Standalone (login events): auditRepository.Append writes one row in its own
// implicit transaction. Callers treat it best-effort (log and continue), so a
// trail write can never fail a login.
//
// Same-transaction (every user/location/visit mutation): the Audited* methods
// below run the mutation query AND InsertAuditLog inside one WithTx. Either
// half failing rolls both back. The mutation statements are the same generated
// queries the plain adapters use (no hand-written SQL, no new predicates);
// they are re-issued here on the tx-scoped query set because the plain methods
// own their pool-scoped queries and cannot join an outer transaction without
// changing the domain ports every existing fake implements.
//
// No audit event exists for status transitions: approve/reject/check-in/out,
// reschedule and the auto-rule worker stay exclusively in status_history.

// auditRepository is the PostgreSQL adapter for domain.AuditRepository.
type auditRepository struct {
	pool *pgxpool.Pool
}

// Compile-time proofs: the adapter serves the plain port, and the existing
// concrete adapters serve the optional same-transaction ports (resolved by
// handlers through type assertion, so narrow fakes keep compiling).
var (
	_ domain.AuditRepository           = (*auditRepository)(nil)
	_ domain.AuditedUserRepository     = (*userRepository)(nil)
	_ domain.AuditedLocationRepository = (*masterRepository)(nil)
	_ domain.AuditedPurposeRepository  = (*masterRepository)(nil)
	_ domain.AuditedVisitRepository    = (*visitRepository)(nil)
)

// NewAuditRepository builds the PostgreSQL-backed domain.AuditRepository.
func NewAuditRepository(pool *pgxpool.Pool) domain.AuditRepository {
	return &auditRepository{pool: pool}
}

// auditParams renders one entry onto the generated insert: unknown actions are
// refused with ErrValidation, secrets are stripped and caps applied, empty
// actor/entity/observation members become SQL NULL, and empty metadata becomes
// SQL NULL rather than an empty JSON object.
func auditParams(entry domain.AuditEntry) (db.InsertAuditLogParams, error) {
	if !domain.IsAuditMVPEvent(entry.Action) {
		return db.InsertAuditLogParams{}, fmt.Errorf("repository: unknown audit action %q: %w", entry.Action, domain.ErrValidation)
	}
	entry = domain.TruncateAuditEntry(entry)
	actor, err := pgNullUUIDPtr(entry.ActorID)
	if err != nil {
		return db.InsertAuditLogParams{}, err
	}
	entityID, err := pgNullUUIDPtr(entry.EntityID)
	if err != nil {
		return db.InsertAuditLogParams{}, err
	}
	var metadata []byte
	if len(entry.Metadata) > 0 {
		raw, err := json.Marshal(entry.Metadata)
		if err != nil {
			return db.InsertAuditLogParams{}, fmt.Errorf("repository: marshal audit metadata: %w: %v", domain.ErrValidation, err)
		}
		metadata = raw
	}
	return db.InsertAuditLogParams{
		UserID:    actor,
		Action:    entry.Action,
		Entity:    entry.Entity,
		EntityID:  entityID,
		Ip:        pgText(strOrNil(entry.IP)),
		UserAgent: pgText(strOrNil(entry.UserAgent)),
		Metadata:  metadata,
	}, nil
}

// strOrNil maps an empty observation to nil so the column stays SQL NULL.
func strOrNil(s string) *string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return &s
}

// auditLogToDomain projects one stored trail row onto the domain shape.
func auditLogToDomain(row db.AuditLog) domain.AuditLog {
	out := domain.AuditLog{
		ID:        mustDomainUUID(row.ID),
		UserID:    domainUUIDPtr(row.UserID),
		Action:    row.Action,
		Entity:    row.Entity,
		EntityID:  domainUUIDPtr(row.EntityID),
		Timestamp: row.Timestamp,
		IP:        textValue(row.Ip),
		UserAgent: textValue(row.UserAgent),
	}
	if len(row.Metadata) > 0 {
		var meta map[string]string
		if err := json.Unmarshal(row.Metadata, &meta); err == nil {
			out.Metadata = meta
		}
	}
	return out
}

// Append writes one trail row standalone (login events). It validates the
// action vocabulary but never the caller's business rules.
func (r *auditRepository) Append(ctx context.Context, entry domain.AuditEntry) (domain.AuditLog, error) {
	params, err := auditParams(entry)
	if err != nil {
		return domain.AuditLog{}, err
	}
	row, err := db.New(r.pool).InsertAuditLog(ctx, params)
	if err != nil {
		return domain.AuditLog{}, MapError(err)
	}
	return auditLogToDomain(row), nil
}

// AppendInTx writes one trail row on the caller's transaction: the
// same-transaction half the audited mutations below share. It is exported for
// current and future tx participants (visit_status pattern) without widening
// the domain port.
func (r *auditRepository) AppendInTx(ctx context.Context, tx pgx.Tx, entry domain.AuditEntry) (domain.AuditLog, error) {
	params, err := auditParams(entry)
	if err != nil {
		return domain.AuditLog{}, err
	}
	row, err := db.New(r.pool).WithTx(tx).InsertAuditLog(ctx, params)
	if err != nil {
		return domain.AuditLog{}, MapError(err)
	}
	return auditLogToDomain(row), nil
}

// appendInTxFunc is the package-local alias the audited mutations use so they
// do not depend on the concrete adapter type.
func appendInTxFunc(ctx context.Context, pool *pgxpool.Pool, tx pgx.Tx, entry domain.AuditEntry) error {
	adapter := &auditRepository{pool: pool}
	_, err := adapter.AppendInTx(ctx, tx, entry)
	return err
}

// hiddenActorIDs returns the user ids the trail must never expose: accounts
// carrying the hidden dev-superadmin role, plus any account whose lower(email)
// equals the seeded dev-superadmin address (the drifted super_admin copy of
// that operator). Both discriminators travel as bound parameters, never as
// interpolated SQL text. An empty map is the fast path: no hidden account, no
// extra work, byte-for-byte the old behaviour.
func hiddenActorIDs(ctx context.Context, pool *pgxpool.Pool) (map[domain.UUID]struct{}, error) {
	rows, err := pool.Query(ctx, `SELECT u.id FROM users u JOIN role r ON r.id = u.role_id WHERE r.name = $1 OR lower(u.email) = lower($2)`, string(domain.RoleDevSuperAdmin), domain.DevSuperadminEmail)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	hidden := map[domain.UUID]struct{}{}
	for rows.Next() {
		var id pgtype.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		if ptr := domainUUIDPtr(id); ptr != nil {
			hidden[*ptr] = struct{}{}
		}
	}
	return hidden, rows.Err()
}

// List serves the filtered trail read with its companion count. Filters travel
// as bound NULLable parameters (the audit.sql FILTER INVARIANT); pagination
// defaults come from NormaliseAuditFilter. Rows written by the hidden
// dev-superadmin account are dropped before the response, and the companion
// total is reduced by exactly the hidden matches, so the {items,total}
// envelope stays consistent. Frontend additionally drops any item whose actor
// cannot be resolved through GET /users (which never lists the hidden
// account): see the audit page users memo.
func (r *auditRepository) List(ctx context.Context, filter domain.AuditFilter) ([]domain.AuditLog, int64, error) {
	filter = domain.NormaliseAuditFilter(filter)
	scope, err := pgNullUUIDPtr(filter.UserID)
	if err != nil {
		return nil, 0, err
	}
	hidden, err := hiddenActorIDs(ctx, r.pool)
	if err != nil {
		return nil, 0, MapError(err)
	}
	var entity, action, search pgtype.Text
	if strings.TrimSpace(filter.Entity) != "" {
		entity = pgtype.Text{String: strings.TrimSpace(filter.Entity), Valid: true}
	}
	if strings.TrimSpace(filter.Action) != "" {
		action = pgtype.Text{String: strings.TrimSpace(filter.Action), Valid: true}
	}
	if filter.Q != "" {
		search = pgtype.Text{String: filter.Q, Valid: true}
	}
	q := db.New(r.pool)
	rows, err := q.ListAuditLogs(ctx, db.ListAuditLogsParams{
		UserID:   scope,
		Entity:   entity,
		Action:   action,
		Q:        search,
		Order:    filter.Order,
		DateFrom: pgTimestamptz(filter.From),
		DateTo:   pgTimestamptz(filter.To),
		Offset:   int32(filter.Offset),
		Limit:    int32(filter.Limit),
	})
	if err != nil {
		return nil, 0, MapError(err)
	}
	total, err := q.CountAuditLogs(ctx, db.CountAuditLogsParams{
		UserID:   scope,
		Entity:   entity,
		Action:   action,
		Q:        search,
		DateFrom: pgTimestamptz(filter.From),
		DateTo:   pgTimestamptz(filter.To),
	})
	if err != nil {
		return nil, 0, MapError(err)
	}
	out := make([]domain.AuditLog, 0, len(rows))
	for _, row := range rows {
		item := auditLogToDomain(row)
		if item.UserID != nil {
			if _, hide := hidden[*item.UserID]; hide {
				continue
			}
		}
		out = append(out, item)
	}
	if len(hidden) > 0 {
		var hiddenTotal int64
		for hid := range hidden {
			hid := hid
			hidScope, err := pgNullUUIDPtr(&hid)
			if err != nil {
				return nil, 0, err
			}
			n, err := q.CountAuditLogs(ctx, db.CountAuditLogsParams{
				UserID:   hidScope,
				Entity:   entity,
				Action:   action,
				Q:        search,
				DateFrom: pgTimestamptz(filter.From),
				DateTo:   pgTimestamptz(filter.To),
			})
			if err != nil {
				return nil, 0, MapError(err)
			}
			hiddenTotal += n
		}
		total -= hiddenTotal
	}
	return out, total, nil
}

// CreateUserAudited persists one branch security account and its user.create
// audit row in ONE transaction (same InsertSecurityUser statement as
// userRepository.Create, re-issued on the tx-scoped query set).
func (r *userRepository) CreateUserAudited(ctx context.Context, user domain.User, audit domain.AuditEntry) (domain.User, error) {
	roleID, err := fromDomainUUID(user.RoleID)
	if err != nil {
		return domain.User{}, err
	}
	locationID, err := pgNullUUIDPtr(user.LocationID)
	if err != nil {
		return domain.User{}, err
	}
	var created domain.User
	err = WithTx(ctx, r.pool, func(tx pgx.Tx) error {
		q := db.New(r.pool).WithTx(tx)
		row, err := q.InsertSecurityUser(ctx, db.InsertSecurityUserParams{
			Name:         user.Name,
			Email:        user.Email,
			PasswordHash: user.PasswordHash,
			Phone:        pgText(phonePtr(user.Phone)),
			RoleID:       roleID,
			LocationID:   locationID,
		})
		if err != nil {
			return MapError(err)
		}
		created = domain.User{
			ID:           mustDomainUUID(row.ID),
			Name:         row.Name,
			Email:        row.Email,
			PasswordHash: user.PasswordHash,
			Phone:        textValue(row.Phone),
			RoleID:       mustDomainUUID(row.RoleID),
			LocationID:   domainUUIDPtr(row.LocationID),
			Type:         domain.UserType(row.Type),
			Status:       domain.UserStatus(row.Status),
			CreatedAt:    row.CreatedAt,
			UpdatedAt:    row.UpdatedAt,
		}
		return appendInTxFunc(ctx, r.pool, tx, audit)
	})
	if err != nil {
		return domain.User{}, err
	}
	return created, nil
}

// CreateManagedUserAudited persists one admin/vendor account and its
// user.create audit row in ONE transaction (same InsertManagedUser statement
// as userRepository.CreateManagedUser).
func (r *userRepository) CreateManagedUserAudited(ctx context.Context, user domain.User, audit domain.AuditEntry) (domain.User, error) {
	roleID, err := fromDomainUUID(user.RoleID)
	if err != nil {
		return domain.User{}, err
	}
	locationID, err := pgNullUUIDPtr(user.LocationID)
	if err != nil {
		return domain.User{}, err
	}
	vendorID, err := pgNullUUIDPtr(user.VendorID)
	if err != nil {
		return domain.User{}, err
	}
	var created domain.User
	err = WithTx(ctx, r.pool, func(tx pgx.Tx) error {
		q := db.New(r.pool).WithTx(tx)
		row, err := q.InsertManagedUser(ctx, db.InsertManagedUserParams{
			Name:               user.Name,
			Email:              user.Email,
			PasswordHash:       user.PasswordHash,
			Phone:              pgText(phonePtr(user.Phone)),
			Nik:                pgText(nikPtr(user.NIK)),
			RoleID:             roleID,
			LocationID:         locationID,
			Type:               string(user.Type),
			Status:             string(user.Status),
			VendorID:           vendorID,
			VendorNameOverride: pgText(user.VendorNameOverride),
		})
		if err != nil {
			return MapError(err)
		}
		created = domain.User{
			ID:                 mustDomainUUID(row.ID),
			Name:               row.Name,
			Email:              row.Email,
			PasswordHash:       user.PasswordHash,
			Phone:              textValue(row.Phone),
			NIK:                textValue(row.Nik),
			RoleID:             mustDomainUUID(row.RoleID),
			LocationID:         domainUUIDPtr(row.LocationID),
			Type:               domain.UserType(row.Type),
			Status:             domain.UserStatus(row.Status),
			VendorID:           domainUUIDPtr(row.VendorID),
			VendorNameOverride: textPtr(row.VendorNameOverride),
			CreatedAt:          row.CreatedAt,
			UpdatedAt:          row.UpdatedAt,
		}
		return appendInTxFunc(ctx, r.pool, tx, audit)
	})
	if err != nil {
		return domain.User{}, err
	}
	return created, nil
}

// UpdateManagedUserAudited applies one partial account edit and its user.update
// audit row in ONE transaction (same UpdateManagedUser statement, including
// the manual-company tri-state, as userRepository.UpdateManagedUser).
func (r *userRepository) UpdateManagedUserAudited(ctx context.Context, id domain.UUID, patch domain.ManagedUserPatch, audit domain.AuditEntry) (domain.User, error) {
	parsed, err := fromDomainUUID(id)
	if err != nil {
		return domain.User{}, err
	}
	locationID, err := pgNullUUIDPtr(patch.LocationID)
	if err != nil {
		return domain.User{}, err
	}
	vendorID, err := pgNullUUIDPtr(patch.VendorID)
	if err != nil {
		return domain.User{}, err
	}
	var (
		hasVendorOverride bool
		vendorOverride    pgtype.Text
	)
	if patch.VendorName != nil {
		hasVendorOverride = true
		if trimmed := strings.TrimSpace(*patch.VendorName); trimmed != "" {
			vendorOverride = pgtype.Text{String: trimmed, Valid: true}
		}
	}
	var updated domain.User
	err = WithTx(ctx, r.pool, func(tx pgx.Tx) error {
		q := db.New(r.pool).WithTx(tx)
		row, err := q.UpdateManagedUser(ctx, db.UpdateManagedUserParams{
			Name:                  patchMemberText(patch.Name),
			Email:                 patchMemberText(patch.Email),
			Phone:                 patchMemberText(patch.Phone),
			Nik:                   patchMemberText(patch.NIK),
			LocationID:            locationID,
			VendorID:              vendorID,
			HasVendorNameOverride: hasVendorOverride,
			VendorNameOverride:    vendorOverride,
			PasswordHash:          patchMemberText(patch.PasswordHash),
			ID:                    parsed,
		})
		if err != nil {
			return MapError(err)
		}
		updated = domain.User{
			ID:                 mustDomainUUID(row.ID),
			Name:               row.Name,
			Email:              row.Email,
			Phone:              textValue(row.Phone),
			NIK:                textValue(row.Nik),
			RoleID:             mustDomainUUID(row.RoleID),
			LocationID:         domainUUIDPtr(row.LocationID),
			Type:               domain.UserType(row.Type),
			Status:             domain.UserStatus(row.Status),
			VendorID:           domainUUIDPtr(row.VendorID),
			VendorNameOverride: textPtr(row.VendorNameOverride),
			CreatedAt:          row.CreatedAt,
			UpdatedAt:          row.UpdatedAt,
		}
		return appendInTxFunc(ctx, r.pool, tx, audit)
	})
	if err != nil {
		return domain.User{}, err
	}
	return updated, nil
}

// UpdateUserStatusAudited flips one account status and its user.status audit
// row in ONE transaction (same UpdateUserStatus statement as
// userRepository.UpdateStatus; the database CHECK stays the second line of
// defence behind the handler validation).
func (r *userRepository) UpdateUserStatusAudited(ctx context.Context, id domain.UUID, status domain.UserStatus, audit domain.AuditEntry) error {
	parsed, err := fromDomainUUID(id)
	if err != nil {
		return err
	}
	return WithTx(ctx, r.pool, func(tx pgx.Tx) error {
		q := db.New(r.pool).WithTx(tx)
		if _, err := q.UpdateUserStatus(ctx, db.UpdateUserStatusParams{
			ID:     parsed,
			Status: string(status),
		}); err != nil {
			return MapError(err)
		}
		return appendInTxFunc(ctx, r.pool, tx, audit)
	})
}

// DeleteUserAudited removes one account row and its user.delete audit row in
// ONE transaction (same DeleteUser statement as userRepository.DeleteUser; a
// raced reference still surfaces ErrConflict through the 23503 mapping).
func (r *userRepository) DeleteUserAudited(ctx context.Context, id domain.UUID, audit domain.AuditEntry) error {
	parsed, err := fromDomainUUID(id)
	if err != nil {
		return err
	}
	return WithTx(ctx, r.pool, func(tx pgx.Tx) error {
		q := db.New(r.pool).WithTx(tx)
		if _, err := q.DeleteUser(ctx, db.DeleteUserParams{ID: parsed}); err != nil {
			return MapError(err)
		}
		return appendInTxFunc(ctx, r.pool, tx, audit)
	})
}

// CreateLocationAudited persists one facility and its location.create audit
// row in ONE transaction (same InsertLocation statement as
// masterRepository.CreateLocation).
func (r *masterRepository) CreateLocationAudited(ctx context.Context, loc domain.Location, audit domain.AuditEntry) (domain.Location, error) {
	var created domain.Location
	err := WithTx(ctx, r.pool, func(tx pgx.Tx) error {
		q := db.New(r.pool).WithTx(tx)
		row, err := q.InsertLocation(ctx, db.InsertLocationParams{
			Name:     loc.Name,
			Type:     string(loc.Type),
			Address:  blankToNullText(loc.Address),
			City:     blankToNullText(loc.City),
			Timezone: string(loc.Timezone),
		})
		if err != nil {
			return mapLocationWriteError(err)
		}
		created = locationModelToDomain(row)
		return appendInTxFunc(ctx, r.pool, tx, audit)
	})
	if err != nil {
		return domain.Location{}, err
	}
	return created, nil
}

// UpdateLocationAudited applies one facility patch and its location.update
// audit row in ONE transaction (same UpdateLocation statement as
// masterRepository.UpdateLocation; nil members keep the stored columns).
func (r *masterRepository) UpdateLocationAudited(ctx context.Context, id domain.UUID, patch domain.LocationPatch, audit domain.AuditEntry) (domain.Location, error) {
	parsed, err := fromDomainUUID(id)
	if err != nil {
		return domain.Location{}, err
	}
	var updated domain.Location
	err = WithTx(ctx, r.pool, func(tx pgx.Tx) error {
		q := db.New(r.pool).WithTx(tx)
		row, err := q.UpdateLocation(ctx, db.UpdateLocationParams{
			ID:       parsed,
			Name:     patchMemberText(patch.Name),
			Type:     patchLocationTypeText(patch.Type),
			Address:  patchMemberText(patch.Address),
			City:     patchMemberText(patch.City),
			Timezone: patchTimezoneText(patch.Timezone),
			IsActive: patchBool(patch.IsActive),
		})
		if err != nil {
			return mapLocationWriteError(err)
		}
		updated = locationModelToDomain(row)
		return appendInTxFunc(ctx, r.pool, tx, audit)
	})
	if err != nil {
		return domain.Location{}, err
	}
	return updated, nil
}

// DeleteLocationAudited removes one facility row and its location.delete audit
// row in ONE transaction (same DeleteLocation statement as
// masterRepository.DeleteLocation; a raced reference is ErrConflict via 23503).
func (r *masterRepository) DeleteLocationAudited(ctx context.Context, id domain.UUID, audit domain.AuditEntry) error {
	parsed, err := fromDomainUUID(id)
	if err != nil {
		return err
	}
	return WithTx(ctx, r.pool, func(tx pgx.Tx) error {
		q := db.New(r.pool).WithTx(tx)
		if _, err := q.DeleteLocation(ctx, db.DeleteLocationParams{ID: parsed}); err != nil {
			return MapError(err)
		}
		return appendInTxFunc(ctx, r.pool, tx, audit)
	})
}

// CreatePurposeAudited persists one catalogue purpose and its purpose.create
// audit row in ONE transaction (same InsertPurpose statement as
// masterRepository.CreatePurpose).
func (r *masterRepository) CreatePurposeAudited(ctx context.Context, purpose domain.Purpose, audit domain.AuditEntry) (domain.Purpose, error) {
	var created domain.Purpose
	err := WithTx(ctx, r.pool, func(tx pgx.Tx) error {
		q := db.New(r.pool).WithTx(tx)
		row, err := q.InsertPurpose(ctx, db.InsertPurposeParams{Name: purpose.Name})
		if err != nil {
			return MapError(err)
		}
		created = purposeRowToDomain(row)
		return appendInTxFunc(ctx, r.pool, tx, audit)
	})
	if err != nil {
		return domain.Purpose{}, err
	}
	return created, nil
}

// UpdatePurposeAudited applies one catalogue patch and its purpose.update
// audit row in ONE transaction (same UpdatePurpose statement as
// masterRepository.UpdatePurpose; nil members keep the stored columns).
func (r *masterRepository) UpdatePurposeAudited(ctx context.Context, id domain.UUID, patch domain.PurposePatch, audit domain.AuditEntry) (domain.Purpose, error) {
	parsed, err := fromDomainUUID(id)
	if err != nil {
		return domain.Purpose{}, err
	}
	var updated domain.Purpose
	err = WithTx(ctx, r.pool, func(tx pgx.Tx) error {
		q := db.New(r.pool).WithTx(tx)
		row, err := q.UpdatePurpose(ctx, db.UpdatePurposeParams{
			ID:       parsed,
			Name:     patchMemberText(patch.Name),
			IsActive: patchBool(patch.IsActive),
		})
		if err != nil {
			return MapError(err)
		}
		updated = purposeRowToDomain(row)
		return appendInTxFunc(ctx, r.pool, tx, audit)
	})
	if err != nil {
		return domain.Purpose{}, err
	}
	return updated, nil
}

// DeletePurposeAudited removes one catalogue purpose row and its
// purpose.delete audit row in ONE transaction (same DeletePurpose statement
// as masterRepository.DeletePurpose; a raced reference is ErrConflict via
// 23503).
func (r *masterRepository) DeletePurposeAudited(ctx context.Context, id domain.UUID, audit domain.AuditEntry) error {
	parsed, err := fromDomainUUID(id)
	if err != nil {
		return err
	}
	return WithTx(ctx, r.pool, func(tx pgx.Tx) error {
		q := db.New(r.pool).WithTx(tx)
		if _, err := q.DeletePurpose(ctx, db.DeletePurposeParams{ID: parsed}); err != nil {
			return MapError(err)
		}
		return appendInTxFunc(ctx, r.pool, tx, audit)
	})
}

// DeleteVisitAudited removes one visit row (children cascade) and its
// visit.delete audit row in ONE transaction (same DeleteVisit statement as
// visitRepository.DeleteVisit; the only visit write feeding the trail).
func (r *visitRepository) DeleteVisitAudited(ctx context.Context, id domain.UUID, audit domain.AuditEntry) error {
	parsed, err := fromDomainUUID(id)
	if err != nil {
		return err
	}
	return WithTx(ctx, r.pool, func(tx pgx.Tx) error {
		q := db.New(r.pool).WithTx(tx)
		if _, err := q.DeleteVisit(ctx, db.DeleteVisitParams{ID: parsed}); err != nil {
			return MapError(err)
		}
		return appendInTxFunc(ctx, r.pool, tx, audit)
	})
}
