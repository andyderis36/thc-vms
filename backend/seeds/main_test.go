package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"thc-vms/backend/seeds/seeddata"
	"thc-vms/backend/seeds/store"
)

// errDialAttempted is returned by the guard dialer below if anything tries to
// reach a database during a dry run.
var errDialAttempted = errors.New("dry run must not open a database connection")

// testPasswordSentinel is a stand-in credential: if it ever appears in printed
// output, the seeder leaked a password and the test says so.
const testPasswordSentinel = "unused-by-this-test"

// configureTestEnv points the seeder at an endpoint nothing listens on, so no
// test in this file can reach a real database even by accident.
func configureTestEnv(t *testing.T) {
	t.Helper()
	t.Setenv("DB_HOST", "127.0.0.1")
	t.Setenv("DB_PORT", "1")
	t.Setenv("DB_USER", "thc_user")
	t.Setenv("DB_PASSWORD", testPasswordSentinel)
	t.Setenv("DB_NAME", "thc_vms_test_sentinel")
	t.Setenv("DB_SSLMODE", "disable")
}

// stubSession is the minimum a store.Session has to do for the command to run.
// What each statement actually says is asserted in ./store, where the full
// recorder lives; this double only reports how a run ended.
type stubSession struct {
	released []bool
	closed   bool
	failWith error
}

func (s *stubSession) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, s.failWith
}

func (s *stubSession) QueryRow(context.Context, string, ...any) pgx.Row {
	return stubRow{}
}

func (s *stubSession) Release(_ context.Context, commit bool) error {
	s.released = append(s.released, commit)
	return nil
}

func (s *stubSession) Close() { s.closed = true }

// stubRow hands back a deterministic non-zero role id, the way RETURNING would.
type stubRow struct{}

func (stubRow) Scan(dst ...any) error {
	if len(dst) != 1 {
		return fmt.Errorf("stubRow.Scan got %d destinations, want 1", len(dst))
	}
	target, ok := dst[0].(*uuid.UUID)
	if !ok {
		return fmt.Errorf("stubRow.Scan got %T, want *uuid.UUID", dst[0])
	}
	*target = seeddata.DeriveID(seeddata.EntityRole, "stub")
	return nil
}

// runSeeding drives a full command through the given session.
func runSeeding(args []string, session store.Session) (string, error) {
	var out bytes.Buffer
	s := newSeeder(args, &out, func(context.Context, string) (store.Session, error) {
		return session, nil
	})
	err := s.run(context.Background())
	return out.String(), err
}

// planCounts reads the "<entity> <count>" pairs back out of the plan output.
// Parsing beats searching for a bare "5": a substring check would be satisfied
// by a date, a size or a coordinate anywhere in the output.
func planCounts(t *testing.T, out string) map[string]int {
	t.Helper()
	counts := map[string]int{}
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		n, err := strconv.Atoi(fields[1])
		if err != nil {
			continue
		}
		counts[fields[0]] = n
	}
	return counts
}

// TestDryRunMakesNoDatabaseCalls proves --dry-run is a genuine no-write mode.
// The environment is pointed at an unreachable endpoint and the dialer is wired
// to fail loudly, so the run can only exit 0 if it validates the plan and
// returns before any connection is attempted.
func TestDryRunMakesNoDatabaseCalls(t *testing.T) {
	configureTestEnv(t)

	var out bytes.Buffer
	s := newSeeder([]string{"--dry-run"}, &out, func(context.Context, string) (store.Session, error) {
		return nil, errDialAttempted
	})

	if err := s.run(context.Background()); err != nil {
		t.Fatalf("--dry-run returned %v, want nil (exit 0)", err)
	}
	want := map[string]int{"roles": 4, "locations": 5, "purposes": 6, "vendors": 2, "users": 7, "visits": 0}
	got := planCounts(t, out.String())
	for entity, n := range want {
		if got[entity] != n {
			t.Errorf("dry-run reported %d %s, want %d; plan was:\n%s", got[entity], entity, n, out.String())
		}
	}
	if !strings.Contains(out.String(), "nothing written") {
		t.Errorf("dry-run output does not say that it wrote nothing:\n%s", out.String())
	}
}

// TestDryRunNeverPrintsThePassword keeps the plan output credential-free.
func TestDryRunNeverPrintsThePassword(t *testing.T) {
	configureTestEnv(t)

	var out bytes.Buffer
	s := newSeeder([]string{"--dry-run"}, &out, func(context.Context, string) (store.Session, error) {
		return nil, errDialAttempted
	})
	if err := s.run(context.Background()); err != nil {
		t.Fatalf("--dry-run returned %v, want nil", err)
	}
	if strings.Contains(out.String(), testPasswordSentinel) {
		t.Errorf("dry-run output leaked the database password:\n%s", out.String())
	}
}

// TestFlagParsing covers the accepted command line: no flag writes, and
// anything unrecognised is a hard error rather than a silent write. The success
// case runs against a stub session, so it exercises the whole command -
// including the commit - without a database.
func TestFlagParsing(t *testing.T) {
	configureTestEnv(t)

	cases := []struct {
		name string
		args []string
		// wantErr marks an argument the seeder must refuse.
		wantErr bool
		// wantWrites marks a case that must reach the database, and therefore
		// must release its unit of work with a commit.
		wantWrites bool
	}{
		{name: "no arguments", args: nil, wantWrites: true},
		{name: "dry run", args: []string{"--dry-run"}},
		{name: "unknown flag", args: []string{"--truncate"}, wantErr: true},
		{name: "stray argument", args: []string{""}, wantErr: true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			session := &stubSession{}
			_, err := runSeeding(c.args, session)
			if c.wantErr {
				if err == nil {
					t.Fatalf("run(%v) returned nil, want an error", c.args)
				}
				return
			}
			if err != nil {
				t.Fatalf("run(%v) returned %v, want nil", c.args, err)
			}
			if c.wantWrites {
				if len(session.released) != 1 || !session.released[0] {
					t.Errorf("run(%v) released with %v, want exactly one commit", c.args, session.released)
				}
				return
			}
			if len(session.released) != 0 {
				t.Errorf("run(%v) touched the database: released %v", c.args, session.released)
			}
		})
	}
}

// TestFailureRollsBackTheWholePlan proves one rejected row cannot leave a
// half-seeded database behind, and that the connection still comes back.
func TestFailureRollsBackTheWholePlan(t *testing.T) {
	configureTestEnv(t)

	session := &stubSession{failWith: errors.New("injected write failure")}

	if _, err := runSeeding(nil, session); err == nil {
		t.Fatal("run succeeded despite an injected failure")
	}
	if len(session.released) != 1 || session.released[0] {
		t.Errorf("released %v, want exactly one rollback", session.released)
	}
	if !session.closed {
		t.Error("session was not closed after a failed run")
	}
}

// TestAnUnconfiguredEnvironmentIsRefused proves a real run never guesses a
// database, while a dry run still works without credentials.
func TestAnUnconfiguredEnvironmentIsRefused(t *testing.T) {
	configureTestEnv(t)
	t.Setenv("DB_NAME", "")

	if _, err := runSeeding(nil, &stubSession{}); err == nil {
		t.Error("a real run proceeded without DB_NAME, want a refusal")
	}
	if _, err := runSeeding([]string{"--dry-run"}, &stubSession{}); err != nil {
		t.Errorf("a dry run refused to preview the plan without credentials: %v", err)
	}
}
