package repository

// Email fan-out suite (async, after-commit only): every in-scope lifecycle
// emission enqueues exactly one email to the active-only recipient set;
// excluded types and rolled-back transactions enqueue zero; a mailer failure
// is a logged dead-letter and never fails the write. The mailer is always the
// domain FakeMailer: no test here dials SMTP.

import (
	"bytes"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"thc-vms/backend/internal/domain"
)

// emailStaffFixture seeds one branch with a full staff roster plus a vendor
// user, and returns the ids the assertions need.
type emailStaffFixture struct {
	loc             domain.UUID
	otherLoc        domain.UUID
	superAdmin      domain.UUID
	devSuperAdmin   domain.UUID
	admin           domain.UUID
	security        domain.UUID
	inactiveAdmin   domain.UUID
	otherAdmin      domain.UUID
	vendor          domain.UUID
	vendorEmail     string
	staffEmails     []string
	superAdminEmail string
	devEmail        string
	adminEmail      string
	securityEmail   string
}

// seedEmailFixture stages the audience matrix: active national staff
// (super_admin + hidden dev-superadmin), active branch staff (admin +
// security), one inactive branch admin (must be excluded), one active admin
// of another branch (must be excluded), and one active vendor user.
func seedEmailFixture(t *testing.T, pool *pgxpool.Pool) emailStaffFixture {
	t.Helper()
	loc := seedLocation(t, pool, "Cabang Surel", "cabang")
	otherLoc := seedLocation(t, pool, "Cabang Surel Lain", "cabang")
	superAdminEmail := "super.surel@thc.test"
	devEmail := "dev.surel@thc.test"
	adminEmail := "admin.surel@thc.test"
	securityEmail := "sec.surel@thc.test"
	vendorEmail := "vendor.surel@vendor.test"
	superAdmin := seedUser(t, pool, seedUserParams{Name: "Super Surel", Email: superAdminEmail, Role: "super_admin", Type: "internal"})
	ensureRole(t, pool, "dev-superadmin")
	devSuperAdmin := seedUser(t, pool, seedUserParams{Name: "Dev Surel", Email: devEmail, Role: "dev-superadmin", Type: "internal"})
	admin := seedUser(t, pool, seedUserParams{Name: "Admin Surel", Email: adminEmail, Role: "admin", Location: loc, Type: "internal"})
	security := seedUser(t, pool, seedUserParams{Name: "Security Surel", Email: securityEmail, Role: "security", Location: loc, Type: "internal"})
	inactiveAdmin := seedUserWithStatus(t, pool, seedUserParams{Name: "Admin Mati", Email: "mati.surel@thc.test", Role: "admin", Location: loc, Type: "internal"}, "inactive")
	otherAdmin := seedUser(t, pool, seedUserParams{Name: "Admin Lain", Email: "lain.surel@thc.test", Role: "admin", Location: otherLoc, Type: "internal"})
	vendor := seedUser(t, pool, seedUserParams{Name: "Vendor Surel", Email: vendorEmail, Role: "vendor", Type: "external"})
	return emailStaffFixture{
		loc: loc, otherLoc: otherLoc,
		superAdmin: superAdmin, devSuperAdmin: devSuperAdmin,
		admin: admin, security: security,
		inactiveAdmin: inactiveAdmin, otherAdmin: otherAdmin,
		vendor:          vendor,
		vendorEmail:     vendorEmail,
		superAdminEmail: superAdminEmail, devEmail: devEmail,
		adminEmail: adminEmail, securityEmail: securityEmail,
		staffEmails: []string{superAdminEmail, devEmail, adminEmail, securityEmail},
	}
}

// ensureRole inserts a role row when the harness seed did not (the harness
// only seeds the four base roles; dev-superadmin arrives via ensureRole).
func ensureRole(t *testing.T, pool *pgxpool.Pool, name string) {
	t.Helper()
	if _, err := pool.Exec(testContext(t),
		`INSERT INTO role (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, name); err != nil {
		t.Fatalf("ensure role %s: %v", name, err)
	}
}

// seedUserWithStatus stages one account with an explicit status; seedUser only
// stages active accounts.
func seedUserWithStatus(t *testing.T, pool *pgxpool.Pool, p seedUserParams, status string) domain.UUID {
	t.Helper()
	var id uuid.UUID
	err := pool.QueryRow(testContext(t),
		`INSERT INTO users (name, email, password_hash, role_id, location_id, type, status)
		 SELECT $1, $2, 'hash-test', r.id, $3, $4, $5 FROM role r WHERE r.name = $6
		 RETURNING id`,
		p.Name, p.Email, uuidArg(p.Location), p.Type, status, p.Role).Scan(&id)
	if err != nil {
		t.Fatalf("seed user %s with status %s: %v", p.Email, status, err)
	}
	return toDomainUUID(id)
}

// seedEmailVisit stages one requested visit owned by the fixture vendor.
func seedEmailVisit(t *testing.T, pool *pgxpool.Pool, code string, fx emailStaffFixture) domain.UUID {
	t.Helper()
	start := time.Now().UTC().Add(24 * time.Hour).Truncate(time.Second)
	return seedVisit(t, pool, seedVisitParams{
		Code: code, VendorUser: fx.vendor, Location: fx.loc,
		Start: start, End: start.Add(4 * time.Hour), Status: domain.VisitStatusRequested,
	})
}

// countTypedNotifs counts one user's notices of one type for one visit.
func countTypedNotifs(t *testing.T, pool *pgxpool.Pool, user, visit domain.UUID, typ domain.NotificationType) int {
	t.Helper()
	notifs := NewNotificationRepository(pool)
	items, _, _, err := notifs.List(testContext(t), domain.NotificationFilter{UserID: user, Page: 1, Limit: 100})
	if err != nil {
		t.Fatalf("list notifications: %v", err)
	}
	n := 0
	for _, it := range items {
		if it.Type == typ && it.VisitRequestID == visit {
			n++
		}
	}
	return n
}

// assertToSet pins the exact recipient set of the single expected email.
func assertToSet(t *testing.T, fake *domain.FakeMailer, want []string) domain.MailCall {
	t.Helper()
	if len(fake.Calls) != 1 {
		t.Fatalf("email calls = %d, want exactly 1", len(fake.Calls))
	}
	got := fake.Calls[0].To
	if len(got) != len(want) {
		t.Fatalf("recipients = %v, want %v", got, want)
	}
	seen := make(map[string]int, len(got))
	for _, addr := range got {
		seen[addr]++
	}
	for _, addr := range want {
		if seen[addr] != 1 {
			t.Fatalf("recipients = %v, want %v", got, want)
		}
	}
	return fake.Calls[0]
}

// TestEmailEnqueue_ApproveSendsOneVendorEmail proves the approve emission
// enqueues exactly one email addressed to the visit's vendor user.
func TestEmailEnqueue_ApproveSendsOneVendorEmail(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	fx := seedEmailFixture(t, pool)
	fake := &domain.FakeMailer{}
	repos := NewVisitRepository(pool).WithMailer(fake)

	visitID := seedEmailVisit(t, pool, "VST-0000000301", fx)
	if err := repos.UpdateStatus(ctx, visitID, domain.VisitStatusApproved, fx.admin, "disetujui"); err != nil {
		t.Fatalf("UpdateStatus approved: %v", err)
	}
	call := assertToSet(t, fake, []string{fx.vendorEmail})
	if !strings.Contains(call.Subject, "VST-0000000301") {
		t.Fatalf("subject = %q, want the visit code", call.Subject)
	}
	if !strings.Contains(call.TextBody, "VST-0000000301") {
		t.Fatalf("text body = %q, want the in_app message with the visit code", call.TextBody)
	}
}

// TestEmailEnqueue_RejectSendsOneVendorEmail proves the reject emission
// enqueues exactly one email addressed to the visit's vendor user.
func TestEmailEnqueue_RejectSendsOneVendorEmail(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	fx := seedEmailFixture(t, pool)
	fake := &domain.FakeMailer{}
	repos := NewVisitRepository(pool).WithMailer(fake)

	visitID := seedEmailVisit(t, pool, "VST-0000000302", fx)
	if err := repos.UpdateStatus(ctx, visitID, domain.VisitStatusRejected, fx.admin, "berkas kurang"); err != nil {
		t.Fatalf("UpdateStatus rejected: %v", err)
	}
	call := assertToSet(t, fake, []string{fx.vendorEmail})
	if !strings.Contains(call.Subject, "VST-0000000302") {
		t.Fatalf("subject = %q, want the visit code", call.Subject)
	}
}

// TestEmailEnqueue_HumanCancelByVendorSendsOneStaffEmail proves a vendor-side
// cancel enqueues exactly one email to the staff audience (national
// super_admins including the hidden dev-superadmin, plus the branch
// admin/security) and none to the vendor itself.
func TestEmailEnqueue_HumanCancelByVendorSendsOneStaffEmail(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	fx := seedEmailFixture(t, pool)
	fake := &domain.FakeMailer{}
	repos := NewVisitRepository(pool).WithMailer(fake)

	visitID := seedEmailVisit(t, pool, "VST-0000000303", fx)
	if err := repos.UpdateStatus(ctx, visitID, domain.VisitStatusCancelled, fx.vendor, "batal vendor"); err != nil {
		t.Fatalf("vendor cancel UpdateStatus: %v", err)
	}
	call := assertToSet(t, fake, fx.staffEmails)
	if !strings.Contains(call.Subject, "VST-0000000303") {
		t.Fatalf("subject = %q, want the visit code", call.Subject)
	}
	for _, addr := range call.To {
		if addr == fx.vendorEmail {
			t.Fatalf("recipients = %v, vendor must not be emailed on its own cancel", call.To)
		}
	}
}

// TestEmailEnqueue_HumanCancelByAdminSendsOneVendorEmail proves an admin-side
// cancel enqueues exactly one email to the vendor user and none to staff.
func TestEmailEnqueue_HumanCancelByAdminSendsOneVendorEmail(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	fx := seedEmailFixture(t, pool)
	fake := &domain.FakeMailer{}
	repos := NewVisitRepository(pool).WithMailer(fake)

	visitID := seedEmailVisit(t, pool, "VST-0000000304", fx)
	if err := repos.UpdateStatus(ctx, visitID, domain.VisitStatusCancelled, fx.admin, "batal admin"); err != nil {
		t.Fatalf("admin cancel UpdateStatus: %v", err)
	}
	assertToSet(t, fake, []string{fx.vendorEmail})
}

// TestEmailEnqueue_RescheduleSendsExactlyOneEmail proves the dual in_app emit
// (staff row + vendor row, same visit_rescheduled type) collapses to exactly
// ONE email addressed to the union of both audiences.
func TestEmailEnqueue_RescheduleSendsExactlyOneEmail(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	fx := seedEmailFixture(t, pool)
	fake := &domain.FakeMailer{}
	repos := NewVisitRepository(pool).WithMailer(fake)

	visitID := seedEmailVisit(t, pool, "VST-0000000305", fx)
	newStart := time.Now().UTC().Add(72 * time.Hour).Truncate(time.Second)
	if err := repos.Reschedule(ctx, visitID, newStart, newStart.Add(6*time.Hour), fx.admin, "genset telat"); err != nil {
		t.Fatalf("Reschedule: %v", err)
	}
	// Both in_app rows exist (the dual emit is unchanged)...
	if n := countTypedNotifs(t, pool, fx.admin, visitID, domain.NotificationVisitRescheduled); n != 1 {
		t.Fatalf("staff visit_rescheduled in_app rows = %d, want 1", n)
	}
	if n := countTypedNotifs(t, pool, fx.vendor, visitID, domain.NotificationVisitRescheduled); n != 1 {
		t.Fatalf("vendor visit_rescheduled in_app rows = %d, want 1", n)
	}
	// ...but exactly one email goes out to the union audience.
	want := append(append([]string{}, fx.staffEmails...), fx.vendorEmail)
	call := assertToSet(t, fake, want)
	if !strings.Contains(call.Subject, "VST-0000000305") {
		t.Fatalf("subject = %q, want the visit code", call.Subject)
	}
}

// TestEmailEnqueue_GateTransitionsFlowThroughUpdateStatus proves the gate
// layer needs no separate hook: gate.CheckIn drives UpdateStatus(visiting)
// and gate.CheckOut drives UpdateStatus(completed), and each of those moves
// already enqueues exactly one staff email here. The gate package pins the
// other half (it performs zero direct sends).
func TestEmailEnqueue_GateTransitionsFlowThroughUpdateStatus(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	fx := seedEmailFixture(t, pool)
	fake := &domain.FakeMailer{}
	repos := NewVisitRepository(pool).WithMailer(fake)

	start := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
	visitID := seedVisit(t, pool, seedVisitParams{
		Code: "VST-0000000306", VendorUser: fx.vendor, Location: fx.loc,
		Start: start, End: start.Add(4 * time.Hour), Status: domain.VisitStatusApproved,
	})
	// What gate.CheckIn executes after its guards pass.
	if err := repos.UpdateStatus(ctx, visitID, domain.VisitStatusVisiting, fx.security, ""); err != nil {
		t.Fatalf("check-in UpdateStatus: %v", err)
	}
	call := assertToSet(t, fake, fx.staffEmails)
	if !strings.Contains(call.Subject, "VST-0000000306") {
		t.Fatalf("check-in subject = %q, want the visit code", call.Subject)
	}
	// What gate.CheckOut executes after its guards pass.
	if err := repos.UpdateStatus(ctx, visitID, domain.VisitStatusCompleted, fx.security, ""); err != nil {
		t.Fatalf("check-out UpdateStatus: %v", err)
	}
	if len(fake.Calls) != 2 {
		t.Fatalf("email calls = %d, want exactly 2 (one per gate transition)", len(fake.Calls))
	}
	out := fake.Calls[1]
	seen := make(map[string]bool, len(out.To))
	for _, addr := range out.To {
		seen[addr] = true
	}
	for _, addr := range fx.staffEmails {
		if !seen[addr] {
			t.Fatalf("check-out recipients = %v, want the staff set %v", out.To, fx.staffEmails)
		}
	}
}

// TestEmailEnqueue_ExcludedTypesSendZero proves visit_requested (Create) and
// visit_auto_cancelled (system cancel, no-show) never reach the mailer.
func TestEmailEnqueue_ExcludedTypesSendZero(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	fx := seedEmailFixture(t, pool)
	fake := &domain.FakeMailer{}
	repos := NewVisitRepository(pool).WithMailer(fake)
	purpose := seedPurpose(t, pool, "Splicing FO")

	// Create emits visit_requested: in_app-only, zero emails.
	created, err := repos.Create(ctx, domain.VisitRequest{
		VendorUserID: fx.vendor, LocationID: fx.loc,
		StartDate: time.Now().UTC().Add(48 * time.Hour).Truncate(time.Second),
		EndDate:   time.Now().UTC().Add(52 * time.Hour).Truncate(time.Second),
		IsNDAAccepted: true,
	}, []domain.Visitor{{Name: "Teknisi Sunyi", IDNumber: "ID-1", Phone: "0811"}}, []domain.UUID{purpose})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if len(fake.Calls) != 0 {
		t.Fatalf("email calls after Create = %d, want 0 (visit_requested is in_app-only)", len(fake.Calls))
	}

	// System cancel emits visit_auto_cancelled: zero emails.
	autoVisit := seedEmailVisit(t, pool, "VST-0000000307", fx)
	if err := repos.UpdateStatus(ctx, autoVisit, domain.VisitStatusCancelled, "", "auto-rule R1"); err != nil {
		t.Fatalf("system cancel UpdateStatus: %v", err)
	}
	if len(fake.Calls) != 0 {
		t.Fatalf("email calls after auto-cancel = %d, want 0", len(fake.Calls))
	}

	// No-show emits visit_auto_cancelled: zero emails.
	noShowVisit := seedVisit(t, pool, seedVisitParams{
		Code: "VST-0000000308", VendorUser: fx.vendor, Location: fx.loc,
		Start: time.Now().UTC().Add(-72 * time.Hour).Truncate(time.Second),
		End:   time.Now().UTC().Add(-68 * time.Hour).Truncate(time.Second),
		Status: domain.VisitStatusApproved,
	})
	if err := repos.UpdateStatus(ctx, noShowVisit, domain.VisitStatusNotVisit, "", "auto-rule R2"); err != nil {
		t.Fatalf("no-show UpdateStatus: %v", err)
	}
	if len(fake.Calls) != 0 {
		t.Fatalf("email calls after no-show = %d, want 0", len(fake.Calls))
	}
	if created.ID == "" {
		t.Fatalf("created visit has an empty id")
	}
}

// TestEmailEnqueue_RollbackSendsZero proves a transaction that rolls back
// (here a changed_by FK violation from an unknown actor) enqueues nothing.
func TestEmailEnqueue_RollbackSendsZero(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	fx := seedEmailFixture(t, pool)
	fake := &domain.FakeMailer{}
	repos := NewVisitRepository(pool).WithMailer(fake)

	visitID := seedEmailVisit(t, pool, "VST-0000000309", fx)
	ghost := domain.UUID(uuid.NewString())
	if err := repos.UpdateStatus(ctx, visitID, domain.VisitStatusApproved, ghost, "disetujui hantu"); err == nil {
		t.Fatalf("UpdateStatus with unknown actor succeeded, want FK failure")
	}
	if len(fake.Calls) != 0 {
		t.Fatalf("email calls after rollback = %d, want 0", len(fake.Calls))
	}
}

// TestEmailEnqueue_MailerErrorStillSucceeds proves a mailer failure never
// fails the request: the write returns nil, the attempt is recorded, and a
// dead-letter line carries the visit code and template type but no password.
func TestEmailEnqueue_MailerErrorStillSucceeds(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	fx := seedEmailFixture(t, pool)
	fake := &domain.FakeMailer{Err: errors.New("smtp 421 downstream temporarily unavailable")}

	var buf bytes.Buffer
	orig := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(orig) })

	repos := NewVisitRepository(pool).WithMailer(fake)
	visitID := seedEmailVisit(t, pool, "VST-0000000310", fx)
	if err := repos.UpdateStatus(ctx, visitID, domain.VisitStatusApproved, fx.admin, "disetujui"); err != nil {
		t.Fatalf("UpdateStatus with failing mailer: %v (mailer errors must never fail the write)", err)
	}
	if len(fake.Calls) != 1 {
		t.Fatalf("email calls = %d, want 1 recorded attempt", len(fake.Calls))
	}
	logged := buf.String()
	if !strings.Contains(logged, "VST-0000000310") {
		t.Fatalf("dead-letter log missing the visit code:\n%s", logged)
	}
	if !strings.Contains(logged, string(domain.NotificationVisitApproved)) {
		t.Fatalf("dead-letter log missing the template type:\n%s", logged)
	}
	if strings.Contains(strings.ToLower(logged), "password") {
		t.Fatalf("dead-letter log must never carry credentials:\n%s", logged)
	}
}

// TestEmailEnqueue_InactiveVendorGetsInAppButZeroEmails proves an
// inactive/pending/blacklisted vendor user still gains its in_app row (the
// existing fan-out is untouched) but receives zero emails.
func TestEmailEnqueue_InactiveVendorGetsInAppButZeroEmails(t *testing.T) {
	for _, status := range []string{"inactive", "pending", "blacklisted"} {
		t.Run(status, func(t *testing.T) {
			pool := testPool(t)
			resetTables(t, pool)
			ctx := testContext(t)
			fx := seedEmailFixture(t, pool)
			quietVendor := seedUserWithStatus(t, pool, seedUserParams{
				Name: "Vendor " + status, Email: status + ".surel@vendor.test",
				Role: "vendor", Type: "external",
			}, status)
			fake := &domain.FakeMailer{}
			repos := NewVisitRepository(pool).WithMailer(fake)

			start := time.Now().UTC().Add(24 * time.Hour).Truncate(time.Second)
			visitID := seedVisit(t, pool, seedVisitParams{
				Code: "VST-0000000311", VendorUser: quietVendor, Location: fx.loc,
				Start: start, End: start.Add(4 * time.Hour), Status: domain.VisitStatusRequested,
			})
			if err := repos.UpdateStatus(ctx, visitID, domain.VisitStatusApproved, fx.admin, "disetujui"); err != nil {
				t.Fatalf("UpdateStatus approved: %v", err)
			}
			if n := countTypedNotifs(t, pool, quietVendor, visitID, domain.NotificationVisitApproved); n != 1 {
				t.Fatalf("in_app visit_approved rows = %d, want 1 (fan-out untouched)", n)
			}
			if len(fake.Calls) != 0 {
				t.Fatalf("email calls for %s vendor = %d, want 0", status, len(fake.Calls))
			}
		})
	}
}

// TestEmailEnqueue_EmptyEmailSkippedNeverErrors proves a vendor row with a
// blank email still gains its in_app row while the enqueue skips the blank
// address (logged) instead of erroring the write.
func TestEmailEnqueue_EmptyEmailSkippedNeverErrors(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	fx := seedEmailFixture(t, pool)
	blankVendor := seedUser(t, pool, seedUserParams{Name: "Vendor Kosong", Email: "", Role: "vendor", Type: "external"})
	fake := &domain.FakeMailer{}

	var buf bytes.Buffer
	orig := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(orig) })

	repos := NewVisitRepository(pool).WithMailer(fake)
	start := time.Now().UTC().Add(24 * time.Hour).Truncate(time.Second)
	visitID := seedVisit(t, pool, seedVisitParams{
		Code: "VST-0000000312", VendorUser: blankVendor, Location: fx.loc,
		Start: start, End: start.Add(4 * time.Hour), Status: domain.VisitStatusRequested,
	})
	if err := repos.UpdateStatus(ctx, visitID, domain.VisitStatusApproved, fx.admin, "disetujui"); err != nil {
		t.Fatalf("UpdateStatus approved: %v", err)
	}
	if n := countTypedNotifs(t, pool, blankVendor, visitID, domain.NotificationVisitApproved); n != 1 {
		t.Fatalf("in_app visit_approved rows = %d, want 1", n)
	}
	if len(fake.Calls) != 0 {
		t.Fatalf("email calls for blank address = %d, want 0", len(fake.Calls))
	}
}

// TestEmailEnqueue_NilMailerSkipsSilently proves a repository built without a
// mailer (SMTP disabled) performs the write with no fan-out attempt.
func TestEmailEnqueue_NilMailerSkipsSilently(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	fx := seedEmailFixture(t, pool)
	repos := NewVisitRepository(pool)

	visitID := seedEmailVisit(t, pool, "VST-0000000313", fx)
	if err := repos.UpdateStatus(ctx, visitID, domain.VisitStatusApproved, fx.admin, "disetujui"); err != nil {
		t.Fatalf("UpdateStatus without mailer: %v", err)
	}
}

// TestResolveEmailRecipients_ActiveOnlyMirrorsFanOut proves the resolver
// returns exactly the staff fan-out set (national super_admins including the
// hidden dev-superadmin plus the branch admin/security, all active) and the
// single active vendor address, excluding inactive, cross-branch and
// non-vendor accounts without ever erroring.
func TestResolveEmailRecipients_ActiveOnlyMirrorsFanOut(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	fx := seedEmailFixture(t, pool)
	resolver := NewNotificationRepository(pool)

	visit := domain.VisitRequest{LocationID: fx.loc, VendorUserID: fx.vendor}
	staff, err := resolver.ResolveEmailRecipients(ctx, visit, domain.NotificationAudienceStaff)
	if err != nil {
		t.Fatalf("ResolveEmailRecipients staff: %v", err)
	}
	seen := make(map[string]bool, len(staff))
	for _, addr := range staff {
		seen[addr] = true
	}
	for _, want := range fx.staffEmails {
		if !seen[want] {
			t.Fatalf("staff recipients = %v, want %v (dev-superadmin keeps feed parity)", staff, fx.staffEmails)
		}
	}
	if len(staff) != len(fx.staffEmails) {
		t.Fatalf("staff recipients = %v, want exactly %v", staff, fx.staffEmails)
	}

	vendor, err := resolver.ResolveEmailRecipients(ctx, visit, domain.NotificationAudienceVendor)
	if err != nil {
		t.Fatalf("ResolveEmailRecipients vendor: %v", err)
	}
	if len(vendor) != 1 || vendor[0] != fx.vendorEmail {
		t.Fatalf("vendor recipients = %v, want [%s]", vendor, fx.vendorEmail)
	}

	// An inactive vendor resolves to zero addresses, not an error.
	quiet := domain.VisitRequest{LocationID: fx.loc,
		VendorUserID: seedUserWithStatus(t, pool, seedUserParams{
			Name: "Vendor Diam", Email: "diam@vendor.test", Role: "vendor", Type: "external",
		}, "inactive")}
	none, err := resolver.ResolveEmailRecipients(ctx, quiet, domain.NotificationAudienceVendor)
	if err != nil {
		t.Fatalf("ResolveEmailRecipients inactive vendor: %v", err)
	}
	if len(none) != 0 {
		t.Fatalf("inactive vendor recipients = %v, want zero", none)
	}

	// An unknown audience resolves to zero addresses, not an error.
	unknown, err := resolver.ResolveEmailRecipients(ctx, visit, domain.NotificationAudience("siluman"))
	if err != nil {
		t.Fatalf("ResolveEmailRecipients unknown audience: %v", err)
	}
	if len(unknown) != 0 {
		t.Fatalf("unknown audience recipients = %v, want zero", unknown)
	}
}
