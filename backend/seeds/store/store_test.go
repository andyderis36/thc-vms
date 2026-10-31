package store

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"golang.org/x/crypto/bcrypt"

	"thc-vms/backend/seeds/seeddata"
)

// insertTarget finds the table a statement writes to, so the tests can assert
// on what the seeder touches rather than on how it spells its SQL.
var insertTarget = regexp.MustCompile(`(?i)INSERT\s+INTO\s+([a-z_]+)`)

type recordedStatement struct {
	sql  string
	args []any
}

// recordingSession stands in for a live transaction. It is a test double, not a
// mock of the database: it cannot enforce a foreign key or a trigger, which is
// exactly why every invariant that the real database would reject is asserted
// here against the recorded statements.
type recordingSession struct {
	statements []recordedStatement
	released   []bool
	closed     bool
	// failOn, when non-empty, fails any statement whose SQL contains it. That
	// is how the rollback path is exercised without a real constraint.
	failOn string
}

func (r *recordingSession) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	r.statements = append(r.statements, recordedStatement{sql: sql, args: args})
	if r.failOn != "" && strings.Contains(sql, r.failOn) {
		return pgconn.CommandTag{}, fmt.Errorf("recording session: injected failure on %q", r.failOn)
	}
	return pgconn.CommandTag{}, nil
}

func (r *recordingSession) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	r.statements = append(r.statements, recordedStatement{sql: sql, args: args})
	name, _ := args[0].(string)
	return stubRow{id: seeddata.DeriveID(seeddata.EntityRole, name)}
}

func (r *recordingSession) Release(_ context.Context, commit bool) error {
	r.released = append(r.released, commit)
	return nil
}

func (r *recordingSession) Close() { r.closed = true }

// insertedTables lists the distinct tables the recorded statements insert into.
func (r *recordingSession) insertedTables() []string {
	seen := map[string]bool{}
	for _, st := range r.statements {
		if m := insertTarget.FindStringSubmatch(st.sql); m != nil {
			seen[m[1]] = true
		}
	}
	out := make([]string, 0, len(seen))
	for t := range seen {
		out = append(out, t)
	}
	sort.Strings(out)
	return out
}

// stubRow answers the role upsert's RETURNING id with a deterministic, non-zero
// uuid, the way a real RETURNING would.
type stubRow struct{ id uuid.UUID }

func (s stubRow) Scan(dst ...any) error {
	if len(dst) != 1 {
		return fmt.Errorf("stubRow.Scan got %d destinations, want 1", len(dst))
	}
	target, ok := dst[0].(*uuid.UUID)
	if !ok {
		return fmt.Errorf("stubRow.Scan got %T, want *uuid.UUID", dst[0])
	}
	*target = s.id
	return nil
}

// applyPlan runs the real plan through the real Apply, with no database.
func applyPlan(t *testing.T, session *recordingSession) error {
	t.Helper()
	p := seeddata.Plan()
	hashes, err := seeddata.HashSeedPasswords(p.Users)
	if err != nil {
		t.Fatalf("HashSeedPasswords: %v", err)
	}
	return Apply(context.Background(), session, p, hashes)
}

// TestApplyNeverSeedsVisits is the audit-trail guard. A visitor-management
// system that comes up already holding visits is reporting history nobody
// authored, so the seeder may write master data and accounts, and nothing else.
func TestApplyNeverSeedsVisits(t *testing.T) {
	session := &recordingSession{}
	if err := applyPlan(t, session); err != nil {
		t.Fatalf("Apply: %v", err)
	}

	got := strings.Join(session.insertedTables(), " ")
	want := "location purpose role users vendor"
	if got != want {
		t.Errorf("Apply inserted into {%s}, want exactly {%s}", got, want)
	}
	for _, forbidden := range []string{
		"visit", "visit_request", "visit_purpose", "visitor", "companion",
		"status_history", "check_in", "check_out",
	} {
		for _, st := range session.statements {
			if insertTarget.MatchString(st.sql) && strings.Contains(strings.ToLower(st.sql), forbidden) {
				t.Errorf("Apply inserted into a forbidden table matching %q:\n%s", forbidden, st.sql)
			}
		}
	}
}

// TestApplySendsTriggerSatisfyingArguments checks the values that actually reach
// the users table, because enforce_user_location_invariant() rejects the whole
// transaction over them and a wrong type is a silent NULL the trigger never
// sees.
func TestApplySendsTriggerSatisfyingArguments(t *testing.T) {
	session := &recordingSession{}
	if err := applyPlan(t, session); err != nil {
		t.Fatalf("Apply: %v", err)
	}

	inserts := 0
	for _, st := range session.statements {
		if !insertTarget.MatchString(st.sql) || !strings.Contains(strings.ToLower(st.sql), "users") {
			continue
		}
		inserts++
		if len(st.args) != 9 {
			t.Errorf("user insert has %d args, want 9 (name, email, hash, role, location, type, status, vendor, nik)", len(st.args))
			continue
		}
		hash, _ := st.args[2].(string)
		if hash == "" || hash == seeddata.DemoPassword {
			t.Errorf("password_hash arg is %q: the password must reach the database only as a hash", hash)
			continue
		}
		if _, err := bcrypt.Cost([]byte(hash)); err != nil {
			t.Errorf("password_hash arg is not a bcrypt hash: %v", err)
		}
		if roleID, ok := st.args[3].(uuid.UUID); !ok || roleID == uuid.Nil {
			t.Errorf("role_id arg is %#v, want a resolved non-zero uuid.UUID", st.args[3])
		}
		// Typed nil pointers are what make an unreferenced location or vendor
		// reach pgx as SQL NULL instead of a uuid.Nil that the trigger reads
		// as "assigned to facility 00000000-0000-0000-0000-000000000000".
		if _, ok := st.args[4].(*uuid.UUID); !ok {
			t.Errorf("location_id arg is %T, want *uuid.UUID", st.args[4])
		}
		if _, ok := st.args[7].(*uuid.UUID); !ok {
			t.Errorf("vendor_id arg is %T, want *uuid.UUID", st.args[7])
		}
		// An absent NIK (security, super_admin) reaches pgx as a typed nil
		// *string (SQL NULL); a populated one (admin, vendor) as its digits.
		nik, ok := st.args[8].(*string)
		if !ok {
			t.Errorf("nik arg is %T, want *string", st.args[8])
		} else if nik != nil && *nik == "" {
			t.Errorf("nik arg is an empty string: absence must be SQL NULL, never ''")
		}
	}
	if inserts != 27 {
		t.Errorf("recorded %d user inserts, want 27", inserts)
	}
}

// TestReferencesAreWrittenBeforeTheyAreUsed pins the order of the plan. A user
// row carries location_id and vendor_id as foreign keys, so the facilities and
// companies it points at must already exist. This is a regression guard for a
// real failure: seeding users before locations aborts the whole transaction on
// users_location_id_fkey, and a recorder cannot enforce a foreign key, so only
// an ordering assertion catches it before a database does.
func TestReferencesAreWrittenBeforeTheyAreUsed(t *testing.T) {
	session := &recordingSession{}
	if err := applyPlan(t, session); err != nil {
		t.Fatalf("Apply: %v", err)
	}

	firstInsert := func(table string) int {
		t.Helper()
		for i, st := range session.statements {
			if m := insertTarget.FindStringSubmatch(st.sql); m != nil && m[1] == table {
				return i
			}
		}
		t.Fatalf("no insert into %s was recorded", table)
		return -1
	}
	users := firstInsert("users")
	for _, parent := range []string{"role", "location", "vendor"} {
		if got := firstInsert(parent); got > users {
			t.Errorf("insert into %s happens at %d, after the users that reference it at %d", parent, got, users)
		}
	}
}

// TestApplyStopsAtTheFirstFailure proves one rejected row aborts the rest of
// the plan instead of leaving the rest of it written.
func TestApplyStopsAtTheFirstFailure(t *testing.T) {
	session := &recordingSession{failOn: "INSERT INTO vendor"}

	err := applyPlan(t, session)
	if err == nil {
		t.Fatal("Apply succeeded despite an injected failure")
	}
	for _, st := range session.statements {
		if strings.Contains(strings.ToLower(st.sql), "insert into users") {
			t.Error("Apply kept writing user rows after a failure")
		}
	}
}

// TestApplyRefusesAnInvalidPlan proves the write path re-checks the rules
// instead of trusting whoever built the plan.
func TestApplyRefusesAnInvalidPlan(t *testing.T) {
	p := seeddata.Plan()
	// Exactly the stale documentation heading for the central office, which
	// chk_location_type does not accept.
	p.Locations[0].Type = "head_office"

	session := &recordingSession{}
	hashes, err := seeddata.HashSeedPasswords(p.Users)
	if err != nil {
		t.Fatalf("HashSeedPasswords: %v", err)
	}
	if err := Apply(context.Background(), session, p, hashes); err == nil {
		t.Fatal("Apply accepted a plan with an invalid location type")
	}
	if len(session.statements) != 0 {
		t.Errorf("Apply wrote %d statements before refusing the plan, want 0", len(session.statements))
	}
}
