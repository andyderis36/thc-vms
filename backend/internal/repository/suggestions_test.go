package repository

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"thc-vms/backend/internal/domain"
)

// seedVendorAccount stages one vendor-role account with an optional catalogue
// company and a manual company override.
func seedVendorAccount(t *testing.T, pool *pgxpool.Pool, name, email string, vendorID domain.UUID, override string) domain.UUID {
	t.Helper()
	var id uuid.UUID
	err := pool.QueryRow(testContext(t),
		`INSERT INTO users (name, email, password_hash, role_id, type, status, vendor_id, vendor_name_override)
		 SELECT $1, $2, 'hash-test', r.id, 'external', 'active', $3, $4 FROM role r WHERE r.name = 'vendor'
		 RETURNING id`,
		name, email, uuidArg(vendorID), overrideArg(override)).Scan(&id)
	if err != nil {
		t.Fatalf("seed vendor account %s: %v", email, err)
	}
	return toDomainUUID(id)
}

// overrideArg maps an empty override to SQL NULL.
func overrideArg(value string) any {
	if value == "" {
		return nil
	}
	return value
}

// textOrNull maps an absent optional string to SQL NULL.
func textOrNull(value *string) any {
	if value == nil || *value == "" {
		return nil
	}
	return *value
}

// seedRosterVisitor stages one roster member.
func seedRosterVisitor(t *testing.T, pool *pgxpool.Pool, visitID domain.UUID, name, idNumber, phone, email, jabatan string, ktp, selfie *string) {
	t.Helper()
	_, err := pool.Exec(testContext(t),
		`INSERT INTO visitor (visit_request_id, name, id_number, phone, email, jabatan, id_card_photo_url, photo_url)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		uuidArg(visitID), name, idNumber, phone, overrideArg(email), overrideArg(jabatan), textOrNull(ktp), textOrNull(selfie))
	if err != nil {
		t.Fatalf("seed visitor %s: %v", name, err)
	}
}

// setVisitVendorOverride stages the visit-level manual company.
func setVisitVendorOverride(t *testing.T, pool *pgxpool.Pool, visitID domain.UUID, value string) {
	t.Helper()
	if _, err := pool.Exec(testContext(t),
		`UPDATE visit_request SET vendor_name_override = $2 WHERE id = $1`, uuidArg(visitID), value); err != nil {
		t.Fatalf("set visit vendor override: %v", err)
	}
}

func hasVendorSuggestion(rows []domain.VendorSuggestion, name string, source domain.VendorSuggestionSource) bool {
	for _, row := range rows {
		if row.Name == name && row.Source == source {
			return true
		}
	}
	return false
}

func hasMemberSuggestion(rows []domain.MemberSuggestion, name string) bool {
	for _, row := range rows {
		if row.Name == name {
			return true
		}
	}
	return false
}

// visitorRowID resolves the stored visitor row staged on one visit so a test
// can prove the list payload carries that exact id (not the visit id).
func visitorRowID(t *testing.T, pool *pgxpool.Pool, visitID domain.UUID, name string) domain.UUID {
	t.Helper()
	var id uuid.UUID
	err := pool.QueryRow(testContext(t),
		`SELECT id FROM visitor WHERE visit_request_id = $1 AND name = $2`, uuidArg(visitID), name).Scan(&id)
	if err != nil {
		t.Fatalf("resolve visitor row %s on visit %s: %v", name, visitID, err)
	}
	return toDomainUUID(id)
}

// suggestionFixture stages two branches: A owns two visits by account A and B
// owns one visit by account B.
type suggestionFixture struct {
	locA, locB        domain.UUID
	vendorAlpha       domain.UUID
	vendorGamma       domain.UUID
	accountA          domain.UUID
	visitA1, visitA2  domain.UUID
	visitB            domain.UUID
	ktpURL, selfieURL string
}

func seedSuggestionFixture(t *testing.T, pool *pgxpool.Pool) suggestionFixture {
	t.Helper()
	resetTables(t, pool)
	locA := seedLocation(t, pool, "POP A", "pop")
	locB := seedLocation(t, pool, "POP B", "pop")
	vendorAlpha := seedVendor(t, pool, "PT Alpha")
	vendorGamma := seedVendor(t, pool, "PT Gamma")
	accountA := seedVendorAccount(t, pool, "Akun A", "akun-a@example.com", vendorAlpha, "PT Alpha Manual")
	accountB := seedVendorAccount(t, pool, "Akun B", "akun-b@example.com", vendorGamma, "")

	older := time.Date(2026, time.October, 1, 9, 0, 0, 0, time.UTC)
	newer := time.Date(2026, time.November, 1, 9, 0, 0, 0, time.UTC)
	visitA1 := seedVisit(t, pool, seedVisitParams{
		Code: "VST-0000000101", VendorUser: accountA, Vendor: vendorAlpha, Location: locA,
		Start: older, End: older.Add(8 * time.Hour), Status: domain.VisitStatusApproved,
	})
	visitA2 := seedVisit(t, pool, seedVisitParams{
		Code: "VST-0000000102", VendorUser: accountA, Location: locA,
		Start: newer, End: newer.Add(8 * time.Hour), Status: domain.VisitStatusApproved,
	})
	visitB := seedVisit(t, pool, seedVisitParams{
		Code: "VST-0000000103", VendorUser: accountB, Vendor: vendorGamma, Location: locB,
		Start: older, End: older.Add(8 * time.Hour), Status: domain.VisitStatusApproved,
	})
	setVisitVendorOverride(t, pool, visitA2, "PT Delta")

	ktp := "http://localhost:9000/thc-vms-bucket/id_cards/visitor-a/ktp.jpg"
	selfie := "http://localhost:9000/thc-vms-bucket/id_cards/visitor-a/selfie.jpg"
	seedRosterVisitor(t, pool, visitA1, "Andi", "IDA1", "0811000001", "andi@example.com", "Teknisi", &ktp, &selfie)
	seedRosterVisitor(t, pool, visitA2, "Andi", "IDA1", "0811000001", "andi@example.com", "Teknisi", nil, nil)
	seedRosterVisitor(t, pool, visitA2, "Citra", "IDC1", "0813000001", "", "", nil, nil)
	seedRosterVisitor(t, pool, visitB, "Budi", "IDB1", "0812000001", "", "", nil, nil)

	return suggestionFixture{
		locA: locA, locB: locB, vendorAlpha: vendorAlpha, vendorGamma: vendorGamma,
		accountA: accountA, visitA1: visitA1, visitA2: visitA2, visitB: visitB,
		ktpURL: ktp, selfieURL: selfie,
	}
}

func TestVendorSuggestionsRespectBranchScope(t *testing.T) {
	pool := testPool(t)
	fixture := seedSuggestionFixture(t, pool)
	repo := NewVisitRepository(pool)

	scoped, err := repo.ListVendorSuggestions(testContext(t), domain.VendorSuggestionFilter{LocationIDs: []domain.UUID{fixture.locA}})
	if err != nil {
		t.Fatalf("scoped vendor suggestions: %v", err)
	}
	if !hasVendorSuggestion(scoped, "PT Alpha", domain.VendorSuggestionSourceMaster) {
		t.Fatalf("in-scope master missing: %+v", scoped)
	}
	if !hasVendorSuggestion(scoped, "PT Alpha Manual", domain.VendorSuggestionSourceAccount) {
		t.Fatalf("in-scope account source missing: %+v", scoped)
	}
	if !hasVendorSuggestion(scoped, "PT Delta", domain.VendorSuggestionSourceHistory) {
		t.Fatalf("in-scope history source missing: %+v", scoped)
	}
	if hasVendorSuggestion(scoped, "PT Gamma", domain.VendorSuggestionSourceMaster) {
		t.Fatalf("out-of-scope PT Gamma leaked: %+v", scoped)
	}

	global, err := repo.ListVendorSuggestions(testContext(t), domain.VendorSuggestionFilter{IsGlobal: true})
	if err != nil {
		t.Fatalf("global vendor suggestions: %v", err)
	}
	if !hasVendorSuggestion(global, "PT Gamma", domain.VendorSuggestionSourceMaster) {
		t.Fatalf("global master missing: %+v", global)
	}

	prefix, err := repo.ListVendorSuggestions(testContext(t), domain.VendorSuggestionFilter{IsGlobal: true, Query: "PT A"})
	if err != nil {
		t.Fatalf("prefix vendor suggestions: %v", err)
	}
	for _, row := range prefix {
		if len(row.Name) < 4 || row.Name[:4] != "PT A" {
			t.Fatalf("prefix filter leaked %q", row.Name)
		}
	}
}

func TestMemberSuggestionsScopeDedupeAndNarrow(t *testing.T) {
	pool := testPool(t)
	fixture := seedSuggestionFixture(t, pool)
	repo := NewVisitRepository(pool)

	scoped, err := repo.ListMemberSuggestions(testContext(t), domain.MemberSuggestionFilter{LocationIDs: []domain.UUID{fixture.locA}})
	if err != nil {
		t.Fatalf("scoped member suggestions: %v", err)
	}
	if len(scoped) != 2 {
		t.Fatalf("got %d members, want 2: %+v", len(scoped), scoped)
	}
	if hasMemberSuggestion(scoped, "Budi") {
		t.Fatalf("out-of-scope Budi leaked: %+v", scoped)
	}
	var andi *domain.MemberSuggestion
	for i := range scoped {
		if scoped[i].Name == "Andi" {
			andi = &scoped[i]
		}
	}
	if andi == nil {
		t.Fatalf("Andi missing: %+v", scoped)
	}
	if andi.SourceVisitID != fixture.visitA2 {
		t.Fatalf("Andi source visit = %q, want the newest %q", andi.SourceVisitID, fixture.visitA2)
	}
	wantAndiID := visitorRowID(t, pool, fixture.visitA2, "Andi")
	if andi.VisitorID != wantAndiID {
		t.Fatalf("Andi visitor id = %q, want the winning visitor row %q", andi.VisitorID, wantAndiID)
	}

	owned, err := repo.ListMemberSuggestions(testContext(t), domain.MemberSuggestionFilter{VendorUserID: &fixture.accountA})
	if err != nil {
		t.Fatalf("vendor member suggestions: %v", err)
	}
	if len(owned) != 2 || hasMemberSuggestion(owned, "Budi") {
		t.Fatalf("vendor ownership filter wrong: %+v", owned)
	}
	var ownedAndi *domain.MemberSuggestion
	for i := range owned {
		if owned[i].Name == "Andi" {
			ownedAndi = &owned[i]
		}
	}
	if ownedAndi == nil {
		t.Fatalf("owned Andi missing: %+v", owned)
	}
	if ownedAndi.VisitorID != wantAndiID {
		t.Fatalf("owned Andi visitor id = %q, want the same winning row %q", ownedAndi.VisitorID, wantAndiID)
	}
	if ownedAndi.SourceVisitID != fixture.visitA2 {
		t.Fatalf("owned Andi source visit = %q, want %q", ownedAndi.SourceVisitID, fixture.visitA2)
	}
	for _, row := range owned {
		if row.VisitorID == "" {
			t.Fatalf("owned member %q missing visitor id: %+v", row.Name, owned)
		}
	}

	narrowed, err := repo.ListMemberSuggestions(testContext(t), domain.MemberSuggestionFilter{
		LocationIDs: []domain.UUID{fixture.locA}, VendorName: "PT Delta",
	})
	if err != nil {
		t.Fatalf("narrow member suggestions: %v", err)
	}
	if len(narrowed) != 2 {
		t.Fatalf("vendor narrow = %+v, want the two members of visit A2", narrowed)
	}
	foreign, err := repo.ListMemberSuggestions(testContext(t), domain.MemberSuggestionFilter{
		LocationIDs: []domain.UUID{fixture.locA}, VendorName: "PT Gamma",
	})
	if err != nil {
		t.Fatalf("foreign narrow: %v", err)
	}
	if len(foreign) != 0 {
		t.Fatalf("foreign vendor narrow leaked rows: %+v", foreign)
	}

	searched, err := repo.ListMemberSuggestions(testContext(t), domain.MemberSuggestionFilter{
		LocationIDs: []domain.UUID{fixture.locA}, Query: "and",
	})
	if err != nil {
		t.Fatalf("member q: %v", err)
	}
	if len(searched) != 1 || searched[0].Name != "Andi" {
		t.Fatalf("member q = %+v, want Andi only", searched)
	}
}

func TestFindVisitorByIDReturnsPhotos(t *testing.T) {
	pool := testPool(t)
	fixture := seedSuggestionFixture(t, pool)
	repo := NewVisitRepository(pool)

	rows, err := repo.ListMemberSuggestions(testContext(t), domain.MemberSuggestionFilter{LocationIDs: []domain.UUID{fixture.locA}, Query: "Andi"})
	if err != nil || len(rows) != 1 {
		t.Fatalf("locate Andi: rows=%+v err=%v", rows, err)
	}
	var visitorID uuid.UUID
	err = pool.QueryRow(testContext(t),
		`SELECT id FROM visitor WHERE visit_request_id = $1 AND name = 'Andi'`, uuidArg(fixture.visitA1)).Scan(&visitorID)
	if err != nil {
		t.Fatalf("resolve Andi row: %v", err)
	}

	visitor, err := repo.FindVisitorByID(testContext(t), toDomainUUID(visitorID))
	if err != nil {
		t.Fatalf("find visitor: %v", err)
	}
	if visitor.Name != "Andi" || visitor.VisitRequestID != fixture.visitA1 {
		t.Fatalf("visitor = %+v", visitor)
	}
	if visitor.IDCardPhotoURL == nil || *visitor.IDCardPhotoURL != fixture.ktpURL {
		t.Fatalf("KTP url = %v, want %q", visitor.IDCardPhotoURL, fixture.ktpURL)
	}
	if visitor.PhotoURL == nil || *visitor.PhotoURL != fixture.selfieURL {
		t.Fatalf("selfie url = %v, want %q", visitor.PhotoURL, fixture.selfieURL)
	}
}
