package repository

import (
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"thc-vms/backend/internal/repository/db"
)

// TestVisitorModelToDomain_MapsEmail pins the list/detail roster projection:
// a stored address rides into the domain, NULL stays absent.
func TestVisitorModelToDomain_MapsEmail(t *testing.T) {
	visitID := uuid.New()
	row := db.ListVisitorsRow{
		ID: visitID, VisitRequestID: visitID,
		Name: "Andi", IDNumber: "ID123", Phone: "0811",
		Email: pgtype.Text{String: "teknisi@example.co.id", Valid: true},
	}

	got := visitorModelToDomain(row)
	if got.Email == nil || *got.Email != "teknisi@example.co.id" {
		t.Fatalf("Email = %v, want %q", got.Email, "teknisi@example.co.id")
	}

	row.Email = pgtype.Text{Valid: false}
	got = visitorModelToDomain(row)
	if got.Email != nil {
		t.Fatalf("Email = %q, want absent (nil)", *got.Email)
	}
}

// TestDbVisitorToDomain_MapsEmail pins the PATCH
// /visits/{id}/visitors/{visitorId} RETURNING projection: the corrected roster
// entry renders its stored address exactly like a list/detail one.
func TestDbVisitorToDomain_MapsEmail(t *testing.T) {
	row := db.Visitor{
		ID: uuid.New(), VisitRequestID: uuid.New(),
		Name: "Andi", IDNumber: "ID123", Phone: "0811",
		Email: pgtype.Text{String: "teknisi@example.co.id", Valid: true},
	}

	got := dbVisitorToDomain(row, pgtype.Text{Valid: false})
	if got.Email == nil || *got.Email != "teknisi@example.co.id" {
		t.Fatalf("Email = %v, want %q", got.Email, "teknisi@example.co.id")
	}

	row.Email = pgtype.Text{Valid: false}
	got = dbVisitorToDomain(row, pgtype.Text{Valid: false})
	if got.Email != nil {
		t.Fatalf("Email = %q, want absent (nil)", *got.Email)
	}
}

// TestGroupVisitorsByVisit_CarriesEmail pins the batched list-path load: the
// grouped roster keeps each member's address.
func TestGroupVisitorsByVisit_CarriesEmail(t *testing.T) {
	visitID := uuid.New()
	mk := func(email pgtype.Text) db.ListVisitorsRow {
		return db.ListVisitorsRow{
			ID: uuid.New(), VisitRequestID: visitID,
			Name: "Andi", IDNumber: "ID123", Phone: "0811",
			Email: email,
		}
	}
	rows := []db.ListVisitorsRow{
		mk(pgtype.Text{String: "a@example.co.id", Valid: true}),
		mk(pgtype.Text{Valid: false}),
	}

	grouped := groupVisitorsByVisit(rows)
	members := grouped[visitID]
	if len(members) != 2 {
		t.Fatalf("grouped members = %d, want 2", len(members))
	}
	if members[0].Email == nil || *members[0].Email != "a@example.co.id" {
		t.Fatalf("members[0].Email = %v, want %q", members[0].Email, "a@example.co.id")
	}
	if members[1].Email != nil {
		t.Fatalf("members[1].Email = %q, want absent (nil)", *members[1].Email)
	}
}

// TestPgTextBlankNull pins the write-path invariant: absent OR blank member
// contact input persists as SQL NULL, never as an empty string.
func TestPgTextBlankNull(t *testing.T) {
	if got := pgTextBlankNull(nil); got.Valid {
		t.Fatalf("pgTextBlankNull(nil) = %v, want NULL", got)
	}
	blank := "   "
	if got := pgTextBlankNull(&blank); got.Valid {
		t.Fatalf("pgTextBlankNull(blank) = %v, want NULL", got)
	}
	empty := ""
	if got := pgTextBlankNull(&empty); got.Valid {
		t.Fatalf("pgTextBlankNull(empty) = %v, want NULL", got)
	}
	raw := "  teknisi@example.co.id  "
	got := pgTextBlankNull(&raw)
	if !got.Valid || got.String != "teknisi@example.co.id" {
		t.Fatalf("pgTextBlankNull = %v, want trimmed %q", got, "teknisi@example.co.id")
	}
}
