// Command seeds loads the THC-VMS master data and demo accounts documented in
// docs/5. LOCAL_DEV.md section 6 into an empty database.
//
//	go run seeds/main.go            # upsert master data + 7 demo users
//	go run seeds/main.go --dry-run  # print the plan, open no connection
//
// The runbook invokes this file by name and `go run` compiles only the file it
// is given, so the command is a single composition root with nothing but
// argument handling, output and dependency wiring in it - the same shape as
// cmd/server/main.go. The data and its rules live in ./seeddata, the SQL and
// connection in ./store.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"

	"thc-vms/backend/seeds/seeddata"
	"thc-vms/backend/seeds/store"
)

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))
	if err := newSeeder(os.Args[1:], os.Stdout, store.Dial).run(context.Background()); err != nil {
		slog.Error("seed failed", "error", err)
		os.Exit(1)
	}
}

// seeder holds the three things a run needs, all injected so the whole command
// can be driven in tests without a console or a socket.
type seeder struct {
	args []string
	out  io.Writer
	dial store.Dialer
}

func newSeeder(args []string, out io.Writer, dial store.Dialer) *seeder {
	return &seeder{args: args, out: out, dial: dial}
}

func (s *seeder) run(ctx context.Context) error {
	dryRun, err := parseFlags(s.args)
	if err != nil {
		return err
	}
	// Build and validate the plan before anything else, so a dry run exercises
	// exactly the rules the real run depends on.
	p := seeddata.Plan()
	if err := seeddata.Validate(p); err != nil {
		return fmt.Errorf("refusing to seed: %w", err)
	}
	if err := s.describeTarget(dryRun); err != nil {
		return err
	}
	if err := s.writePlan(p, dryRun); err != nil {
		return err
	}
	if dryRun {
		return nil
	}
	return s.write(ctx, p)
}

func (s *seeder) write(ctx context.Context, p seeddata.SeedPlan) error {
	target, err := store.ResolveTarget()
	if err != nil {
		return err
	}
	db, err := s.dial(ctx, target.DSN())
	if err != nil {
		return err
	}
	defer db.Close()

	hashes, err := seeddata.HashSeedPasswords(p.Users)
	if err != nil {
		return err
	}
	if err := store.Apply(ctx, db, p, hashes); err != nil {
		// Roll back explicitly so no partial plan can be observed, and report
		// both failures if the rollback itself failed.
		if rbErr := db.Release(ctx, false); rbErr != nil {
			return errors.Join(err, rbErr)
		}
		return err
	}
	if err := db.Release(ctx, true); err != nil {
		return fmt.Errorf("committing seed transaction: %w", err)
	}
	slog.Info("seed transaction committed",
		"roles", len(p.Roles), "locations", len(p.Locations), "purposes", len(p.Purposes),
		"vendors", len(p.Vendors), "users", len(p.Users))
	return nil
}

// describeTarget prints where the run would connect, without the password. A
// dry run tolerates an unconfigured environment: the plan it prints does not
// depend on credentials, and demanding a password just to preview counts would
// be noise.
func (s *seeder) describeTarget(dryRun bool) error {
	target, err := store.ResolveTarget()
	switch {
	case err == nil:
		_, err = fmt.Fprintf(s.out, "target: %s\n", target.Address())
	case dryRun:
		_, err = fmt.Fprintf(s.out, "target: not configured (%v); a dry run needs no database\n", err)
	default:
		return err
	}
	if err != nil {
		return fmt.Errorf("writing target line: %w", err)
	}
	return nil
}

func parseFlags(args []string) (dryRun bool, err error) {
	for _, a := range args {
		switch a {
		case "--dry-run":
			dryRun = true
		default:
			return false, fmt.Errorf("unknown argument %q; the only flag is --dry-run", a)
		}
	}
	return dryRun, nil
}

func (s *seeder) writePlan(p seeddata.SeedPlan, dryRun bool) error {
	mode := "applying"
	if dryRun {
		mode = "dry run: no connection opened, nothing written"
	}
	lines := []struct {
		what  string
		count int
		keys  string
	}{
		{"roles", len(p.Roles), names(p.Roles, func(r seeddata.SeedRole) string { return r.Name })},
		{"locations", len(p.Locations), names(p.Locations, func(l seeddata.SeedLocation) string { return l.Code + " (" + l.Type + ")" })},
		{"purposes", len(p.Purposes), names(p.Purposes, func(x seeddata.SeedPurpose) string { return x.Code })},
		{"vendors", len(p.Vendors), names(p.Vendors, func(v seeddata.SeedVendor) string { return v.Name })},
		{"users", len(p.Users), names(p.Users, func(u seeddata.SeedUser) string { return u.Email })},
	}
	if _, err := fmt.Fprintf(s.out, "THC VMS seed plan (%s)\n", mode); err != nil {
		return err
	}
	for _, l := range lines {
		if _, err := fmt.Fprintf(s.out, "  %-9s %2d  %s\n", l.what, l.count, l.keys); err != nil {
			return err
		}
	}
	// Stated out loud because it matters: a visitor-management system that
	// comes up already holding visits is reporting a fabricated audit trail.
	_, err := fmt.Fprint(s.out, "  visits    0  none - visits, visitors and attendance are created through the API, never seeded\n")
	return err
}

func names[T any](rows []T, pick func(T) string) string {
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		out = append(out, pick(r))
	}
	return strings.Join(out, ", ")
}
