package repository

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// TestScopeGrepGate_NoBareScalarScopePredicate is the close-out scope-grep
// gate: the flipped list queries (visits, users, notifications) must carry the
// scope-union predicate (is_global + ANY(location_ids) + EXISTS on
// user_locations) and must not regress to a bare scalar location_id = $N scope.
// It reads the SQL sources directly so it runs without a database and fails
// fast in `go test ./...` if a query is reverted.
func TestScopeGrepGate_NoBareScalarScopePredicate(t *testing.T) {
	files := []string{"visits.sql", "users.sql", "notifications.sql"}
	for _, name := range files {
		path := filepath.Join("db", "queries", name)
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		src := string(raw)

		if !strings.Contains(src, "is_global") {
			t.Errorf("%s: missing scope-union token 'is_global'", name)
		}
		if !strings.Contains(src, "ANY(") {
			t.Errorf("%s: missing scope-union token 'ANY('", name)
		}
	}

	// users + notifications widen the match through user_locations coverage.
	for _, name := range []string{"users.sql", "notifications.sql"} {
		path := filepath.Join("db", "queries", name)
		raw, _ := os.ReadFile(path)
		src := string(raw)
		if !strings.Contains(src, "user_locations") {
			t.Errorf("%s: missing coverage table 'user_locations'", name)
		}
		if !strings.Contains(src, "EXISTS") {
			t.Errorf("%s: missing 'EXISTS' coverage predicate", name)
		}
	}

	// visits.sql must expose the three role-scoped list queries.
	visitsRaw, _ := os.ReadFile(filepath.Join("db", "queries", "visits.sql"))
	visitsSrc := string(visitsRaw)
	for _, q := range []string{"ListVisitsForSuperAdmin", "ListVisitsForLocation", "ListVisitsForVendorUser"} {
		if !strings.Contains(visitsSrc, q) {
			t.Errorf("visits.sql: missing flipped query %s", q)
		}
	}
	for _, q := range []string{"CountVisitsForSuperAdmin", "CountVisitsForLocation", "CountVisitsForVendorUser"} {
		if !strings.Contains(visitsSrc, q) {
			t.Errorf("visits.sql: missing flipped count query %s", q)
		}
	}

	// Bare scalar scope predicate: a single positional param used directly as
	// the location scope in a WHERE. None of the flipped list queries may use it.
	bareScalar := regexp.MustCompile(`location_id\s*=\s*\$\d+`)
	for _, name := range files {
		path := filepath.Join("db", "queries", name)
		raw, _ := os.ReadFile(path)
		if m := bareScalar.FindString(string(raw)); m != "" {
			t.Errorf("%s: bare scalar scope predicate found: %q", name, m)
		}
	}
}
