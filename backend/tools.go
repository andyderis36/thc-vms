//go:build tools

// Package tools pins the third-party modules that later waves import for the
// first time (migrations, JWT auth, pgx repositories, MinIO storage) so that
// go.mod keeps exactly the seven mandated versions from day one. Without
// these blank imports, `go mod tidy` would strip the four modules that this
// wave's production code does not import yet. This file is never compiled
// into the server binary (build tag `tools`).
package tools

import (
	_ "github.com/golang-jwt/jwt/v5"
	_ "github.com/golang-migrate/migrate/v4"
	_ "github.com/jackc/pgx/v5"
	_ "github.com/minio/minio-go/v7"
)
