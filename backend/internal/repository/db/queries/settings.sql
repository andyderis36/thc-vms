-- =============================================================================
-- settings.sql - App settings (ERD: app_settings, migration 000026).
-- =============================================================================

-- name: GetAppSetting :one
SELECT key, value, version, updated_at, updated_by
FROM app_settings
WHERE key = sqlc.arg('key');

-- name: UpsertAppSetting :one
INSERT INTO app_settings (key, value, version, updated_by)
VALUES (sqlc.arg('key'), sqlc.arg('value'), 1, sqlc.narg('updated_by')::uuid)
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value,
    version = app_settings.version + 1,
    updated_at = now(),
    updated_by = EXCLUDED.updated_by
RETURNING key, value, version, updated_at, updated_by;
