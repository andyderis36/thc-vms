package repository

// Adapter proof for migration 000020 (vendor_registration_notices) through
// the domain port: InsertPending queues one pending row idempotently,
// Resolve flips it to approved/rejected with a resolved_at stamp, and
// ListPending serves the openapi PendingRegistrationItem shape newest-first
// with the bell count. Runs against the scratch database via the shared
// harness pool and skips when Docker is down, like every other adapter test.

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"thc-vms/backend/internal/domain"
)

// seedPendingVendorParams stages one vendor account with status 'pending'
// (the shape public self-registration writes): a nil phone/nik becomes SQL
// NULL and an empty vendorID becomes SQL NULL, mirroring seedUser.
type seedPendingVendorParams struct {
	Name     string
	Email    string
	Phone    *string
	NIK      *string
	VendorID domain.UUID
}

func seedPendingVendor(t *testing.T, pool *pgxpool.Pool, p seedPendingVendorParams) domain.UUID {
	t.Helper()
	var id uuid.UUID
	err := pool.QueryRow(testContext(t),
		`INSERT INTO users (name, email, password_hash, phone, nik, role_id, type, status, vendor_id)
		 SELECT $1, $2, 'hash-test', $3, $4, r.id, 'external', 'pending', $5 FROM role r WHERE r.name = 'vendor'
		 RETURNING id`,
		p.Name, p.Email, pgText(p.Phone), pgText(p.NIK), uuidArg(p.VendorID)).Scan(&id)
	if err != nil {
		t.Fatalf("seed pending vendor %s: %v", p.Email, err)
	}
	return toDomainUUID(id)
}

func strRef(s string) *string { return &s }

// backdateNotice pins a notice created_at so newest-first ordering is
// deterministic instead of relying on now() gaps between inserts.
func backdateNotice(t *testing.T, pool *pgxpool.Pool, vendorID domain.UUID, at time.Time) {
	t.Helper()
	if _, err := pool.Exec(testContext(t),
		`UPDATE vendor_registration_notices SET created_at = $2 WHERE vendor_user_id = $1`,
		uuidArg(vendorID), at); err != nil {
		t.Fatalf("backdate notice: %v", err)
	}
}

// TestVendorRegistrationNoticeInsertPendingIdempotent pins the ON CONFLICT
// DO NOTHING anchor through the port: the retry affects no row and the
// first row (id, pending status, NULL resolved_at) is untouched.
func TestVendorRegistrationNoticeInsertPendingIdempotent(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	repo := NewVendorRegistrationNoticeRepository(pool)

	vendorID := seedPendingVendor(t, pool, seedPendingVendorParams{
		Name: "Vendor Antre", Email: "antre-" + uuid.NewString() + "@example.com",
	})

	if err := repo.InsertPending(ctx, vendorID); err != nil {
		t.Fatalf("InsertPending: %v", err)
	}
	var first uuid.UUID
	var status string
	var resolved pgtype.Timestamptz
	if err := pool.QueryRow(ctx, `SELECT id, status, resolved_at FROM vendor_registration_notices
		WHERE vendor_user_id = $1`, uuidArg(vendorID)).Scan(&first, &status, &resolved); err != nil {
		t.Fatalf("read notice: %v", err)
	}
	if status != "pending" {
		t.Fatalf("status = %q, want pending default", status)
	}
	if resolved.Valid {
		t.Fatalf("resolved_at must stay NULL while pending")
	}

	if err := repo.InsertPending(ctx, vendorID); err != nil {
		t.Fatalf("idempotent InsertPending retry: %v", err)
	}
	var second uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT id FROM vendor_registration_notices
		WHERE vendor_user_id = $1`, uuidArg(vendorID)).Scan(&second); err != nil {
		t.Fatalf("read notice after retry: %v", err)
	}
	if first != second {
		t.Fatalf("retry changed the row: %v != %v", first, second)
	}
}

// TestVendorRegistrationNoticeResolve pins the decision write: approved and
// rejected flip status and stamp resolved_at, resolved rows leave the bell
// count, and a repeated decision is a no-op success.
func TestVendorRegistrationNoticeResolve(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	repo := NewVendorRegistrationNoticeRepository(pool)

	approvedID := seedPendingVendor(t, pool, seedPendingVendorParams{
		Name: "Vendor Setuju", Email: "setuju-" + uuid.NewString() + "@example.com",
	})
	rejectedID := seedPendingVendor(t, pool, seedPendingVendorParams{
		Name: "Vendor Tolak", Email: "tolak-" + uuid.NewString() + "@example.com",
	})
	for _, id := range []domain.UUID{approvedID, rejectedID} {
		if err := repo.InsertPending(ctx, id); err != nil {
			t.Fatalf("InsertPending %s: %v", id, err)
		}
	}

	if err := repo.Resolve(ctx, approvedID, domain.VendorRegistrationApproved); err != nil {
		t.Fatalf("Resolve approved: %v", err)
	}
	var status string
	var resolved pgtype.Timestamptz
	if err := pool.QueryRow(ctx, `SELECT status, resolved_at FROM vendor_registration_notices
		WHERE vendor_user_id = $1`, uuidArg(approvedID)).Scan(&status, &resolved); err != nil {
		t.Fatalf("read resolved notice: %v", err)
	}
	if status != "approved" {
		t.Fatalf("status = %q, want approved", status)
	}
	if !resolved.Valid {
		t.Fatalf("resolved_at must be stamped on decision")
	}

	items, total, pendingCount, err := repo.ListPending(ctx, 1, 20)
	if err != nil {
		t.Fatalf("ListPending: %v", err)
	}
	if total != 1 || pendingCount != 1 {
		t.Fatalf("total = %d pendingCount = %d, want 1 and 1", total, pendingCount)
	}
	if len(items) != 1 || items[0].VendorUserID != rejectedID {
		t.Fatalf("pending queue must hold only the undecided vendor, got %+v", items)
	}

	if err := repo.Resolve(ctx, rejectedID, domain.VendorRegistrationRejected); err != nil {
		t.Fatalf("Resolve rejected: %v", err)
	}
	items, total, pendingCount, err = repo.ListPending(ctx, 1, 20)
	if err != nil {
		t.Fatalf("ListPending after all resolved: %v", err)
	}
	if len(items) != 0 || total != 0 || pendingCount != 0 {
		t.Fatalf("resolved queue must be empty, got items=%d total=%d pending=%d", len(items), total, pendingCount)
	}

	// A repeated decision on an already resolved notice is a no-op success:
	// the pending guard leaves the row (and its first stamp) alone.
	if err := repo.Resolve(ctx, approvedID, domain.VendorRegistrationApproved); err != nil {
		t.Fatalf("repeated Resolve: %v", err)
	}
}

// TestVendorRegistrationNoticeListPendingShape pins the
// PendingRegistrationItem wire shape: the account join, NULL phone/nik as
// empty strings, the catalogue vendor name, newest-first ordering and
// pagination with the shared bell count.
func TestVendorRegistrationNoticeListPendingShape(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	repo := NewVendorRegistrationNoticeRepository(pool)

	companyID := seedVendor(t, pool, "PT Splicing Nusantara")
	newerID := seedPendingVendor(t, pool, seedPendingVendorParams{
		Name: "Teknisi Baru", Email: "baru-" + uuid.NewString() + "@example.com",
		Phone: strRef("0812000111222"), NIK: strRef("3201010101010001"), VendorID: companyID,
	})
	olderID := seedPendingVendor(t, pool, seedPendingVendorParams{
		Name: "Teknisi Lama", Email: "lama-" + uuid.NewString() + "@example.com",
	})
	for _, id := range []domain.UUID{newerID, olderID} {
		if err := repo.InsertPending(ctx, id); err != nil {
			t.Fatalf("InsertPending %s: %v", id, err)
		}
	}
	now := time.Now().UTC()
	backdateNotice(t, pool, newerID, now)
	backdateNotice(t, pool, olderID, now.Add(-time.Hour))

	items, total, pendingCount, err := repo.ListPending(ctx, 1, 20)
	if err != nil {
		t.Fatalf("ListPending: %v", err)
	}
	if total != 2 || pendingCount != 2 {
		t.Fatalf("total = %d pendingCount = %d, want 2 and 2", total, pendingCount)
	}
	if len(items) != 2 {
		t.Fatalf("got %d items, want 2", len(items))
	}
	first := items[0]
	if first.VendorUserID != newerID {
		t.Fatalf("newest first: got %s, want %s", first.VendorUserID, newerID)
	}
	if first.Name != "Teknisi Baru" || first.Phone != "0812000111222" || first.NIK != "3201010101010001" {
		t.Fatalf("account join mismatch: %+v", first)
	}
	if first.VendorName != "PT Splicing Nusantara" {
		t.Fatalf("vendor_name = %q, want catalogue name", first.VendorName)
	}
	if first.Status != domain.VendorRegistrationPending {
		t.Fatalf("status = %q, want pending", first.Status)
	}
	if first.CreatedAt.IsZero() {
		t.Fatalf("created_at must be populated")
	}
	second := items[1]
	if second.VendorUserID != olderID || second.Phone != "" || second.NIK != "" || second.VendorName != "" {
		t.Fatalf("NULL columns must render as empty strings: %+v", second)
	}

	page1, total1, _, err := repo.ListPending(ctx, 1, 1)
	if err != nil {
		t.Fatalf("ListPending page 1: %v", err)
	}
	page2, total2, _, err := repo.ListPending(ctx, 2, 1)
	if err != nil {
		t.Fatalf("ListPending page 2: %v", err)
	}
	if total1 != 2 || total2 != 2 {
		t.Fatalf("paged totals = %d/%d, want 2/2", total1, total2)
	}
	if len(page1) != 1 || len(page2) != 1 || page1[0].VendorUserID == page2[0].VendorUserID {
		t.Fatalf("pages must split the queue, got %+v and %+v", page1, page2)
	}
}

// TestVendorRegistrationNoticeResolveRejectsPendingStatus pins the closed
// vocabulary at the port: resolving back to pending is a validation error,
// never a row that carries a resolved_at stamp while pending.
func TestVendorRegistrationNoticeResolveRejectsPendingStatus(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	repo := NewVendorRegistrationNoticeRepository(pool)

	vendorID := seedPendingVendor(t, pool, seedPendingVendorParams{
		Name: "Vendor Antre", Email: "vocab-" + uuid.NewString() + "@example.com",
	})
	requireErrIs(t,
		repo.Resolve(testContext(t), vendorID, domain.VendorRegistrationPending),
		domain.ErrValidation, "Resolve to pending")
}
