// Package migrations embeds the SQL migration files so the application can
// run them as a library at startup (APP_ENV=local) without the migrate CLI.
//
// go:embed cannot reach a parent directory, so this file lives beside the
// .sql files it embeds: one source of truth for the schema. Adding this .go
// file does not affect sqlc, whose schema: points at the single .up.sql.
package migrations

import "embed"

// FS holds every *.sql file in this directory: the up migration the embedded
// runner applies and the down migration kept for operators.

//go:embed *.sql
var FS embed.FS
