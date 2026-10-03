package repository

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
)

// TestVisitFieldsToDomain_MapsPICNameAndEmail pins the vendor enrichment: the
// users join columns ride along into the domain so the FE Informasi Kunjungan
// card renders pic_user.name without an extra query.
func TestVisitFieldsToDomain_MapsPICNameAndEmail(t *testing.T) {
	id := uuid.New()
	pic := uuid.New()
	loc := uuid.New()
	now := time.Now().UTC().Truncate(time.Second)

	got, err := visitFieldsToDomain(
		id, "VST-0000000001", pic, pgtype.UUID{Valid: false}, loc,
		now, now.Add(4*time.Hour), false, "approved",
		pgtype.Text{Valid: false}, true, pgtype.Text{Valid: false},
		pgtype.Text{Valid: false},
		now, now, pgtype.Text{Valid: false},
		"POP Tebet", "pop",
		"Dimas Prasetyo", "dimas@vendor.example",
	)
	if err != nil {
		t.Fatalf("visitFieldsToDomain: %v", err)
	}
	if got.PICUserName != "Dimas Prasetyo" {
		t.Fatalf("PICUserName = %q, want Dimas Prasetyo", got.PICUserName)
	}
	if got.PICUserEmail != "dimas@vendor.example" {
		t.Fatalf("PICUserEmail = %q, want dimas@vendor.example", got.PICUserEmail)
	}
	if got.LocationName != "POP Tebet" {
		t.Fatalf("LocationName = %q, want POP Tebet", got.LocationName)
	}
}
