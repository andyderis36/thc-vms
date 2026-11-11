package repository

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/repository/db"
)

// settingsRepository is the PostgreSQL adapter for domain.SettingsRepository.
type settingsRepository struct {
	pool *pgxpool.Pool
}

var _ domain.SettingsRepository = (*settingsRepository)(nil)

// NewSettingsRepository builds the PostgreSQL-backed domain.SettingsRepository.
func NewSettingsRepository(pool *pgxpool.Pool) *settingsRepository {
	return &settingsRepository{pool: pool}
}

// LoadNotificationSettings implements domain.SettingsLoader.
func (r *settingsRepository) LoadNotificationSettings(ctx context.Context) (domain.NotificationSettings, error) {
	raw, version, found, err := r.Get(ctx, domain.SettingsKeyNotifications)
	if err != nil {
		return domain.DefaultNotificationSettings(), err
	}
	if !found {
		st := domain.DefaultNotificationSettings()
		st.Version = 1
		return st, nil
	}
	st := domain.ParseNotificationSettings(raw)
	st.Version = version
	return st, nil
}

// Get reads one app_settings row. found=false when the key does not exist.
func (r *settingsRepository) Get(ctx context.Context, key string) ([]byte, int, bool, error) {
	row, err := db.New(r.pool).GetAppSetting(ctx, db.GetAppSettingParams{Key: key})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, 0, false, nil
		}
		return nil, 0, false, MapError(err)
	}
	return row.Value, int(row.Version), true, nil
}

// Update writes the value with version+1 inside one transaction and appends
// the audit row on the same transaction. expectedVersion 0 skips the stale
// check (first write / missing row).
func (r *settingsRepository) Update(ctx context.Context, key string, value []byte, expectedVersion int, updatedBy *domain.UUID, auditEntry domain.AuditEntry) (int, error) {
	var newVersion int
	err := WithTx(ctx, r.pool, func(tx pgx.Tx) error {
		q := db.New(r.pool).WithTx(tx)
		row, err := q.GetAppSetting(ctx, db.GetAppSettingParams{Key: key})
		currentVersion := 0
		found := true
		if err != nil {
			if !errors.Is(err, pgx.ErrNoRows) {
				return MapError(err)
			}
			found = false
		} else {
			currentVersion = int(row.Version)
		}
		if found && expectedVersion != 0 && expectedVersion != currentVersion {
			return domain.Conflict("Versi pengaturan sudah berubah. Muat ulang dan coba lagi.")
		}
		updatedByUUID, err := pgNullUUIDPtr(updatedBy)
		if err != nil {
			return err
		}
		upserted, err := q.UpsertAppSetting(ctx, db.UpsertAppSettingParams{
			Key:       key,
			Value:     value,
			UpdatedBy: updatedByUUID,
		})
		if err != nil {
			return MapError(err)
		}
		newVersion = int(upserted.Version)
		return appendInTxFunc(ctx, r.pool, tx, auditEntry)
	})
	if err != nil {
		return 0, err
	}
	return newVersion, nil
}
