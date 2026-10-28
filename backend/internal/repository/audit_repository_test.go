package repository

import (
	"testing"
	"time"

	"github.com/google/uuid"

	"thc-vms/backend/internal/domain"
)

// The tests below run against the scratch database (skipped without Docker,
// like the rest of the package). They prove the HYBRID contract at the SQL
// level: the audited mutations commit the row and its trail row together, and
// a failure on either half rolls both back.

// auditTestActor wipes the scratch tables and stages one account to own audit
// rows (the user_id FK forbids dangling actors, which the rollback tests
// exploit on purpose).
func auditTestActor(t *testing.T) domain.UUID {
	t.Helper()
	pool := testPool(t)
	resetTables(t, pool)
	return seedUser(t, pool, seedUserParams{
		Name: "Audit Actor", Email: "audit-actor@thc.local", Role: "super_admin", Type: "internal",
	})
}

func mustListTotal(t *testing.T, repo domain.AuditRepository, filter domain.AuditFilter) int64 {
	t.Helper()
	_, total, err := repo.List(testContext(t), filter)
	if err != nil {
		t.Fatalf("list audit logs: %v", err)
	}
	return total
}

func TestAudit_AppendRejectsUnknownAction(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	repo := NewAuditRepository(pool)
	if _, err := repo.Append(testContext(t), domain.AuditEntry{
		Action: "visit.approve", Entity: "visit",
	}); err == nil {
		t.Fatal("unknown action must be refused, never stored")
	} else {
		requireErrIs(t, err, domain.ErrValidation, "unknown audit action")
	}
}

func TestAudit_AppendAndListFilters(t *testing.T) {
	pool := testPool(t)
	actor := auditTestActor(t)
	repo := NewAuditRepository(pool)
	ctx := testContext(t)

	loc := seedLocation(t, pool, "POP Audit", "pop")
	other := seedUser(t, pool, seedUserParams{
		Name: "Other", Email: "other@thc.local", Role: "admin", Location: loc, Type: "internal",
	})
	entries := []domain.AuditEntry{
		{ActorID: &actor, Action: domain.AuditActionLoginSuccess, Entity: domain.AuditEntityUser, EntityID: &actor, IP: "10.0.0.1", UserAgent: "Test/1.0", Metadata: map[string]string{"email": "audit-actor@thc.local"}},
		{Action: domain.AuditActionLoginFailed, Entity: domain.AuditEntityUser, Metadata: map[string]string{"email": "ghost@thc.local", "reason": "invalid_credentials"}},
		{ActorID: &other, Action: domain.AuditActionLocationCreate, Entity: domain.AuditEntityLocation, EntityID: &loc, Metadata: map[string]string{"name": "POP Audit"}},
	}
	for _, entry := range entries {
		if _, err := repo.Append(ctx, entry); err != nil {
			t.Fatalf("append %s: %v", entry.Action, err)
		}
	}

	if total := mustListTotal(t, repo, domain.AuditFilter{}); total != 3 {
		t.Fatalf("unfiltered total = %d, want 3", total)
	}
	if total := mustListTotal(t, repo, domain.AuditFilter{Action: domain.AuditActionLoginFailed}); total != 1 {
		t.Fatalf("failed-login total = %d, want 1", total)
	}
	if total := mustListTotal(t, repo, domain.AuditFilter{Entity: domain.AuditEntityLocation}); total != 1 {
		t.Fatalf("location total = %d, want 1", total)
	}
	if total := mustListTotal(t, repo, domain.AuditFilter{UserID: &other}); total != 1 {
		t.Fatalf("actor-scoped total = %d, want 1", total)
	}
	items, total, err := repo.List(ctx, domain.AuditFilter{Action: domain.AuditActionLoginSuccess})
	if err != nil || total != 1 || len(items) != 1 {
		t.Fatalf("login success read = %d items total %d err %v, want 1/1/nil", len(items), total, err)
	}
	got := items[0]
	if got.UserID == nil || *got.UserID != actor || got.IP != "10.0.0.1" || got.UserAgent != "Test/1.0" {
		t.Fatalf("stored row lost provenance: %+v", got)
	}
	if got.Metadata["email"] != "audit-actor@thc.local" {
		t.Fatalf("stored metadata = %v, want the email", got.Metadata)
	}
	if got.EntityID == nil || *got.EntityID != actor {
		t.Fatalf("stored entity id = %v, want the actor", got.EntityID)
	}
}

func TestAudit_SameTxRollbackOnAuditFailure(t *testing.T) {
	pool := testPool(t)
	auditTestActor(t)
	users := NewManagedUserRepository(pool)
	locations := NewLocationAdminRepository(pool)
	ctx := testContext(t)

	// A well-formed but absent actor trips the audit_log.user_id FK AFTER the
	// mutation ran: the whole transaction must roll back.
	ghost := domain.UUID(uuid.NewString())
	auditedUsers, ok := users.(domain.AuditedUserRepository)
	if !ok {
		t.Fatal("user adapter must serve the audited port")
	}
	// The doomed row itself is valid (branch stationed) so only the ghost
	// actor trips the audit FK: the mutation must roll back with it.
	doomBranch := seedLocation(t, pool, "Cabang Doomed", "cabang")
	if _, err := auditedUsers.CreateManagedUserAudited(ctx, domain.User{
		Name: "Doomed Admin", Email: "doomed@thc.local", PasswordHash: "hash",
		RoleID: roleIDOf(t, pool, "admin"), LocationID: &doomBranch,
		Type: domain.UserTypeInternal, Status: domain.UserStatusActive,
	}, domain.AuditEntry{
		ActorID: &ghost, Action: domain.AuditActionUserCreate,
		Entity: domain.AuditEntityUser, Metadata: map[string]string{"email": "doomed@thc.local"},
	}); err == nil {
		t.Fatal("FK-violating audit row must fail the transaction")
	}
	// The failed create returns no id, so absence is proven through the
	// listing port: no account may carry the doomed email.
	orphans, err := users.ListManagedUsers(ctx, domain.UserFilter{Search: "doomed@thc.local"})
	if err != nil {
		t.Fatalf("list after rollback: %v", err)
	}
	if len(orphans) != 0 {
		t.Fatalf("rolled-back user row must not exist, got %+v", orphans)
	}
	if total := mustListTotal(t, NewAuditRepository(pool), domain.AuditFilter{Action: domain.AuditActionUserCreate}); total != 0 {
		t.Fatalf("rolled-back audit total = %d, want 0", total)
	}

	auditedLocations, ok := locations.(domain.AuditedLocationRepository)
	if !ok {
		t.Fatal("location adapter must serve the audited port")
	}
	if _, err := auditedLocations.CreateLocationAudited(ctx, domain.Location{
		Name: "Doomed POP", Type: domain.LocationCabang, Timezone: domain.TimezoneWIB, IsActive: true,
	}, domain.AuditEntry{
		ActorID: &ghost, Action: domain.AuditActionLocationCreate,
		Entity: domain.AuditEntityLocation, Metadata: map[string]string{"name": "Doomed POP"},
	}); err == nil {
		t.Fatal("FK-violating audit row must fail the transaction")
	}
	if total := mustListTotal(t, NewAuditRepository(pool), domain.AuditFilter{Action: domain.AuditActionLocationCreate}); total != 0 {
		t.Fatalf("rolled-back audit total = %d, want 0", total)
	}
}

func TestAudit_SameTxRollbackOnMutationFailure(t *testing.T) {
	pool := testPool(t)
	actor := auditTestActor(t)
	visits := NewVisitRepository(pool)
	repo := NewAuditRepository(pool)
	ctx := testContext(t)

	// Deleting a missing visit fails BEFORE any audit row is written: nothing
	// may be left behind.
	missing := domain.UUID(uuid.NewString())
	auditedVisits, ok := visits.(domain.AuditedVisitRepository)
	if !ok {
		t.Fatal("visit adapter must serve the audited port")
	}
	entry := domain.AuditEntry{
		ActorID: &actor, Action: domain.AuditActionVisitDelete,
		Entity: domain.AuditEntityVisit, EntityID: &missing,
	}
	if err := auditedVisits.DeleteVisitAudited(ctx, missing, entry); err == nil {
		t.Fatal("deleting a missing visit must fail")
	} else {
		requireErrIs(t, err, domain.ErrNotFound, "delete missing visit")
	}
	if total := mustListTotal(t, repo, domain.AuditFilter{Action: domain.AuditActionVisitDelete}); total != 0 {
		t.Fatalf("failed-mutation audit total = %d, want 0", total)
	}

	// Same for the account delete: the 404 leaves no trail row.
	auditedUsers := NewManagedUserRepository(pool).(domain.AuditedUserRepository)
	if err := auditedUsers.DeleteUserAudited(ctx, missing, domain.AuditEntry{
		ActorID: &actor, Action: domain.AuditActionUserDelete, Entity: domain.AuditEntityUser, EntityID: &missing,
	}); err == nil {
		t.Fatal("deleting a missing user must fail")
	}
	if total := mustListTotal(t, repo, domain.AuditFilter{Action: domain.AuditActionUserDelete}); total != 0 {
		t.Fatalf("failed-mutation audit total = %d, want 0", total)
	}
}

func TestAudit_HappyPathWritesBoth(t *testing.T) {
	pool := testPool(t)
	actor := auditTestActor(t)
	locations := NewLocationAdminRepository(pool)
	visits := NewVisitRepository(pool)
	repo := NewAuditRepository(pool)
	ctx := testContext(t)

	auditedLocations := locations.(domain.AuditedLocationRepository)
	created, err := auditedLocations.CreateLocationAudited(ctx, domain.Location{
		Name: "POP Trail", Type: domain.LocationPOP, Timezone: domain.TimezoneWIB, IsActive: true,
	}, domain.AuditEntry{
		ActorID: &actor, Action: domain.AuditActionLocationCreate,
		Entity: domain.AuditEntityLocation, IP: "10.0.0.2", UserAgent: "Happy/1.0",
		Metadata: map[string]string{"name": "POP Trail"},
	})
	if err != nil {
		t.Fatalf("audited create location: %v", err)
	}
	if _, err := locations.FindLocationByID(ctx, created.ID); err != nil {
		t.Fatalf("created facility must be readable: %v", err)
	}
	items, total, err := repo.List(ctx, domain.AuditFilter{Action: domain.AuditActionLocationCreate})
	if err != nil || total != 1 || len(items) != 1 {
		t.Fatalf("create trail = %d items total %d err %v, want 1/1/nil", len(items), total, err)
	}
	if items[0].UserID == nil || *items[0].UserID != actor || items[0].Metadata["name"] != "POP Trail" {
		t.Fatalf("create trail row wrong: %+v", items[0])
	}

	// One visit purge end to end: the visit vanishes, its visit.delete row stays.
	vendorUser := seedUser(t, pool, seedUserParams{
		Name: "Vendor/Mitra", Email: "vendor@vendor.example", Role: "vendor", Type: "external",
	})
	visitID := seedVisit(t, pool, seedVisitParams{
		Code: "VST-0000000099", VendorUser: vendorUser, Location: created.ID,
		Start: time.Now().Add(time.Hour), End: time.Now().Add(2 * time.Hour),
		Status: domain.VisitStatusRequested,
	})
	auditedVisits := visits.(domain.AuditedVisitRepository)
	if err := auditedVisits.DeleteVisitAudited(ctx, visitID, domain.AuditEntry{
		ActorID: &actor, Action: domain.AuditActionVisitDelete,
		Entity: domain.AuditEntityVisit, EntityID: &visitID,
		Metadata: map[string]string{"visit_code": "VST-0000000099"},
	}); err != nil {
		t.Fatalf("audited delete visit: %v", err)
	}
	if _, err := visits.FindByID(ctx, visitID); err == nil {
		t.Fatal("purged visit must be gone")
	} else {
		requireErrIs(t, err, domain.ErrNotFound, "purged visit read")
	}
	if total := mustListTotal(t, repo, domain.AuditFilter{Action: domain.AuditActionVisitDelete}); total != 1 {
		t.Fatalf("delete trail total = %d, want 1", total)
	}

	// Location purge closes the loop: facility gone, both rows present. The
	// seeded visit above referenced this facility, but it is already purged,
	// so the delete must now succeed.
	deleteEntry := domain.AuditEntry{
		ActorID: &actor, Action: domain.AuditActionLocationDelete,
		Entity: domain.AuditEntityLocation, EntityID: &created.ID,
		Metadata: map[string]string{"name": "POP Trail"},
	}
	if err := locations.(domain.AuditedLocationRepository).DeleteLocationAudited(ctx, created.ID, deleteEntry); err != nil {
		t.Fatalf("audited delete location: %v", err)
	}
	if _, err := locations.FindLocationByID(ctx, created.ID); err == nil {
		t.Fatal("purged facility must be gone")
	}
	if total := mustListTotal(t, repo, domain.AuditFilter{Entity: domain.AuditEntityLocation}); total != 2 {
		t.Fatalf("location trail total = %d, want create+delete", total)
	}
}

func TestAudit_UserStatusAuditedWritesBoth(t *testing.T) {
	pool := testPool(t)
	actor := auditTestActor(t)
	users := NewManagedUserRepository(pool)
	repo := NewAuditRepository(pool)
	ctx := testContext(t)

	branch := seedLocation(t, pool, "Cabang Flip", "cabang")
	target := seedUser(t, pool, seedUserParams{
		Name: "Flip", Email: "flip@thc.local", Role: "admin", Location: branch, Type: "internal",
	})
	audited := users.(domain.AuditedUserRepository)
	entry := domain.AuditEntry{
		ActorID: &actor, Action: domain.AuditActionUserStatus,
		Entity: domain.AuditEntityUser, EntityID: &target,
		Metadata: map[string]string{"from": "active", "to": "inactive"},
	}
	if err := audited.UpdateUserStatusAudited(ctx, target, domain.UserStatusInactive, entry); err != nil {
		t.Fatalf("audited status flip: %v", err)
	}
	updated, err := users.FindManagedByID(ctx, target)
	if err != nil {
		t.Fatalf("flipped account must be readable: %v", err)
	}
	if updated.User.Status != domain.UserStatusInactive {
		t.Fatalf("status = %q, want inactive", updated.User.Status)
	}
	items, total, err := repo.List(ctx, domain.AuditFilter{Action: domain.AuditActionUserStatus})
	if err != nil || total != 1 || len(items) != 1 {
		t.Fatalf("status trail = %d items total %d err %v, want 1/1/nil", len(items), total, err)
	}
	if items[0].Metadata["from"] != "active" || items[0].Metadata["to"] != "inactive" {
		t.Fatalf("status trail metadata = %v, want from/to", items[0].Metadata)
	}
}

func TestAudit_DeleteUserKeepsTrailWithNullActor(t *testing.T) {
	pool := testPool(t)
	actor := auditTestActor(t)
	users := NewManagedUserRepository(pool)
	repo := NewAuditRepository(pool)
	ctx := testContext(t)

	victim := seedUser(t, pool, seedUserParams{
		Name: "Detached Security", Email: "detached@thc.local", Role: "security",
		Location: seedLocation(t, pool, "Cabang Detached", "cabang"), Type: "internal",
	})
	if _, err := repo.Append(ctx, domain.AuditEntry{
		ActorID: &victim, Action: domain.AuditActionUserStatus,
		Entity: domain.AuditEntityUser, EntityID: &victim,
	}); err != nil {
		t.Fatalf("seed victim trail: %v", err)
	}

	audited := users.(domain.AuditedUserRepository)
	if err := audited.DeleteUserAudited(ctx, victim, domain.AuditEntry{
		ActorID: &actor, Action: domain.AuditActionUserDelete,
		Entity: domain.AuditEntityUser, EntityID: &victim,
	}); err != nil {
		t.Fatalf("delete user owning audit rows: %v", err)
	}

	var remaining int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM users WHERE id = $1`, uuidArg(victim)).Scan(&remaining); err != nil {
		t.Fatalf("count victim: %v", err)
	}
	if remaining != 0 {
		t.Fatalf("victim rows = %d, want 0", remaining)
	}

	detached, total, err := repo.List(ctx, domain.AuditFilter{Action: domain.AuditActionUserStatus})
	if err != nil || total != 1 || len(detached) != 1 {
		t.Fatalf("detached trail = %d items total %d err %v, want 1/1/nil", len(detached), total, err)
	}
	if detached[0].UserID != nil {
		t.Fatalf("actor user_id = %v, want NULL after delete", *detached[0].UserID)
	}

	purge, _, err := repo.List(ctx, domain.AuditFilter{Action: domain.AuditActionUserDelete})
	if err != nil || len(purge) != 1 {
		t.Fatalf("purge trail = %d items err %v, want 1", len(purge), err)
	}
	if purge[0].UserID == nil || *purge[0].UserID != actor {
		t.Fatalf("purge actor = %v, want surviving admin", purge[0].UserID)
	}
}
