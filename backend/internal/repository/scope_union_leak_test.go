package repository

// Scope-union leak suite (RED first): branch reads and the staff fan-out must
// follow the user_locations union, not the scalar primary alone.
//
// An admin covering branches A+B (primary A, coverage {A,B}) must manage the
// security users of A-union-B, see the notifications of A-union-B, and receive
// the staff fan-out of a visit at any branch of the union — while branch C
// stays invisible everywhere. The vendor role never enters the staff
// expansion even when it holds a coverage row (the r.name guard owns that).
//
// Every test below fails on the scalar predicates and passes once the queries
// use the scope-union pattern (ANY(location_ids) + is_global for the reads,
// EXISTS on user_locations for the fan-out).

import (
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/repository/db"
)

func TestScopeUnion_ListSecuritySeesCoverageUnion(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	users := NewUserRepository(pool)
	securityRole := roleIDOf(t, pool, "security")

	locA := seedLocation(t, pool, "Cabang Union A", "cabang")
	locB := seedLocation(t, pool, "Cabang Union B", "pop")
	locC := seedLocation(t, pool, "Cabang Union C", "cabang")

	// Security officer whose PRIMARY is B but whose coverage spans A+B: an
	// admin of A must manage them (union read), not lose them (scalar read).
	if _, err := users.Create(ctx, domain.User{
		Name: "Pengawas AB", Email: "pengawas.ab@thc.test", PasswordHash: "hash-ab",
		Phone: "0811", RoleID: securityRole, LocationID: &locB,
		LocationIDs: []domain.UUID{locB, locA},
		Type:        domain.UserTypeInternal, Status: domain.UserStatusActive,
	}); err != nil {
		t.Fatalf("Create security AB: %v", err)
	}
	// Security officer stationed at C only: must stay invisible to A.
	if _, err := users.Create(ctx, domain.User{
		Name: "Pengawas C", Email: "pengawas.c@thc.test", PasswordHash: "hash-c",
		Phone: "0812", RoleID: securityRole, LocationID: &locC,
		Type: domain.UserTypeInternal, Status: domain.UserStatusActive,
	}); err != nil {
		t.Fatalf("Create security C: %v", err)
	}

	got, err := users.ListSecurity(ctx, []domain.UUID{locA}, false)
	if err != nil {
		t.Fatalf("ListSecurity: %v", err)
	}
	seenAB, seenC := false, false
	for _, u := range got {
		switch u.Email {
		case "pengawas.ab@thc.test":
			seenAB = true
		case "pengawas.c@thc.test":
			seenC = true
		}
	}
	if !seenAB {
		t.Fatalf("ListSecurity(A) missing B-primary officer with A in union: scalar predicate leaked")
	}
	if seenC {
		t.Fatalf("ListSecurity(A) shows branch-C officer: isolation break")
	}
}

func TestScopeUnion_ListManagedUsersSeesCoverageUnion(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	managed := NewManagedUserRepository(pool)
	adminRole := roleIDOf(t, pool, "admin")

	locA := seedLocation(t, pool, "Cabang Kelola A", "cabang")
	locB := seedLocation(t, pool, "Cabang Kelola B", "pop")
	locC := seedLocation(t, pool, "Cabang Kelola C", "cabang")

	if _, err := managed.CreateManagedUser(ctx, domain.User{
		Name: "Admin AB", Email: "admin.ab@thc.test", PasswordHash: "hash-ab",
		Phone: "0821", RoleID: adminRole, LocationID: &locB,
		LocationIDs: []domain.UUID{locB, locA},
		Type:        domain.UserTypeInternal, Status: domain.UserStatusActive,
	}); err != nil {
		t.Fatalf("CreateManagedUser AB: %v", err)
	}
	if _, err := managed.CreateManagedUser(ctx, domain.User{
		Name: "Admin C", Email: "admin.c@thc.test", PasswordHash: "hash-c",
		Phone: "0822", RoleID: adminRole, LocationID: &locC,
		Type: domain.UserTypeInternal, Status: domain.UserStatusActive,
	}); err != nil {
		t.Fatalf("CreateManagedUser C: %v", err)
	}

	got, err := managed.ListManagedUsers(ctx, domain.UserFilter{LocationID: &locA})
	if err != nil {
		t.Fatalf("ListManagedUsers: %v", err)
	}
	seenAB, seenC := false, false
	for _, m := range got {
		switch m.User.Email {
		case "admin.ab@thc.test":
			seenAB = true
		case "admin.c@thc.test":
			seenC = true
		}
	}
	if !seenAB {
		t.Fatalf("ListManagedUsers(A) missing B-primary admin with A in union: scalar predicate leaked")
	}
	if seenC {
		t.Fatalf("ListManagedUsers(A) shows branch-C admin: isolation break")
	}
}

func TestScopeUnion_NotificationListSeesCallerUnion(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	managed := NewManagedUserRepository(pool)
	notifs := NewNotificationRepository(pool)
	adminRole := roleIDOf(t, pool, "admin")

	locA := seedLocation(t, pool, "Cabang Notif A", "cabang")
	locB := seedLocation(t, pool, "Cabang Notif B", "pop")
	locC := seedLocation(t, pool, "Cabang Notif C", "cabang")

	caller, err := managed.CreateManagedUser(ctx, domain.User{
		Name: "Admin Notif", Email: "admin.notif@thc.test", PasswordHash: "hash-n",
		Phone: "0831", RoleID: adminRole, LocationID: &locA,
		LocationIDs: []domain.UUID{locA, locB},
		Type:        domain.UserTypeInternal, Status: domain.UserStatusActive,
	})
	if err != nil {
		t.Fatalf("CreateManagedUser caller: %v", err)
	}
	vendorUser := seedUser(t, pool, seedUserParams{Name: "Vendor N", Email: "vendor.n@notif.local", Role: "vendor", Type: "external"})
	now := time.Now().UTC()
	visitA := seedVisit(t, pool, seedVisitParams{Code: "VST-0000000701", VendorUser: vendorUser, Location: locA, Start: now.Add(time.Hour), End: now.Add(2 * time.Hour), Status: domain.VisitStatusApproved})
	visitB := seedVisit(t, pool, seedVisitParams{Code: "VST-0000000702", VendorUser: vendorUser, Location: locB, Start: now.Add(time.Hour), End: now.Add(2 * time.Hour), Status: domain.VisitStatusApproved})
	visitC := seedVisit(t, pool, seedVisitParams{Code: "VST-0000000703", VendorUser: vendorUser, Location: locC, Start: now.Add(time.Hour), End: now.Add(2 * time.Hour), Status: domain.VisitStatusApproved})
	for _, v := range []domain.UUID{visitA, visitB, visitC} {
		if _, err := pool.Exec(ctx, `INSERT INTO notification (user_id, visit_request_id, type, title, message)
			VALUES ($1, $2, 'visit_approved', 'Disetujui', 'OK')`, uuidArg(caller.ID), uuidArg(v)); err != nil {
			t.Fatalf("seed notification: %v", err)
		}
	}

	items, total, _, err := notifs.List(ctx, domain.NotificationFilter{UserID: caller.ID, LocationID: &locA, Page: 1, Limit: 100})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if total != 2 {
		t.Fatalf("total = %d, want 2 (branches A+B of the caller union, C excluded)", total)
	}
	seenB, seenC := false, false
	for _, it := range items {
		if it.LocationID == locB {
			seenB = true
		}
		if it.LocationID == locC {
			seenC = true
		}
	}
	if !seenB {
		t.Fatalf("List(A) missing branch-B notice of the caller union: scalar predicate leaked")
	}
	if seenC {
		t.Fatalf("List(A) shows branch-C notice: isolation break")
	}
}

func TestScopeUnion_StaffFanOutReachesCoverageUnion(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	users := NewUserRepository(pool)
	securityRole := roleIDOf(t, pool, "security")

	locA := seedLocation(t, pool, "Cabang Fanout A", "cabang")
	locB := seedLocation(t, pool, "Cabang Fanout B", "pop")
	locC := seedLocation(t, pool, "Cabang Fanout C", "cabang")

	adminA := seedUser(t, pool, seedUserParams{Name: "Admin A", Email: "admin.a@fanout.local", Role: "admin", Location: locA, Type: "internal"})
	_ = adminA
	// B-primary officer covering A+B: the fan-out of a visit at A must reach them.
	if _, err := users.Create(ctx, domain.User{
		Name: "Pengawas AB", Email: "pengawas.ab@fanout.local", PasswordHash: "hash-ab",
		Phone: "0841", RoleID: securityRole, LocationID: &locB,
		LocationIDs: []domain.UUID{locB, locA},
		Type:        domain.UserTypeInternal, Status: domain.UserStatusActive,
	}); err != nil {
		t.Fatalf("Create security AB: %v", err)
	}
	adminC := seedUser(t, pool, seedUserParams{Name: "Admin C", Email: "admin.c@fanout.local", Role: "admin", Location: locC, Type: "internal"})
	_ = adminC
	// A vendor account that somehow holds a coverage row at A: the staff
	// expansion must still exclude it (r.name guard, never the union).
	vendorV := seedUser(t, pool, seedUserParams{Name: "Vendor V", Email: "vendor.v@fanout.local", Role: "vendor", Type: "external"})
	if _, err := pool.Exec(ctx, `INSERT INTO user_locations (user_id, location_id) VALUES ($1, $2)`,
		uuidArg(vendorV), uuidArg(locA)); err != nil {
		t.Fatalf("seed vendor coverage: %v", err)
	}

	vendorOwner := seedUser(t, pool, seedUserParams{Name: "Vendor O", Email: "vendor.o@fanout.local", Role: "vendor", Type: "external"})
	now := time.Now().UTC().Truncate(time.Second)
	visit := seedVisit(t, pool, seedVisitParams{Code: "VST-0000000704", VendorUser: vendorOwner, Location: locA, Start: now.Add(time.Hour), End: now.Add(2 * time.Hour), Status: domain.VisitStatusRequested})

	locAID, err := fromDomainUUID(locA)
	if err != nil {
		t.Fatalf("parse locA: %v", err)
	}
	visitID, err := fromDomainUUID(visit)
	if err != nil {
		t.Fatalf("parse visit: %v", err)
	}
	q := db.New(pool)
	if err := q.InsertStaffNotifications(ctx, db.InsertStaffNotificationsParams{
		VisitRequestID: visitID,
		Type:           string(domain.NotificationVisitApproved),
		Title:          "Disetujui",
		Message:        "OK",
		CreatedAt:      now,
		LocationID:     locAID,
	}); err != nil {
		t.Fatalf("InsertStaffNotifications: %v", err)
	}
	emails, err := q.ListStaffEmailRecipients(ctx, db.ListStaffEmailRecipientsParams{LocationID: locAID})
	if err != nil {
		t.Fatalf("ListStaffEmailRecipients: %v", err)
	}
	want := map[string]bool{"admin.a@fanout.local": false, "pengawas.ab@fanout.local": false}
	for _, addr := range emails {
		if _, ok := want[addr]; ok {
			want[addr] = true
			continue
		}
		t.Fatalf("fan-out reached %q, want only the A-union-B staff (C and vendor excluded)", addr)
	}
	for addr, seen := range want {
		if !seen {
			t.Fatalf("fan-out missing %q: coverage union not followed", addr)
		}
	}
}
