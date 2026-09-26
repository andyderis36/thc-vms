package config

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

// DotEnvFile is the optional file Load consults before reading the process
// environment, matching the runbook in docs/5. LOCAL_DEV.md section 5
// ("cp .env.example .env" then "go run cmd/server/main.go").
//
// The backend deliberately has no dotenv dependency: a third-party loader would
// be the only new module in an otherwise seven-module manifest, and the format
// is a flat KEY=VALUE list. The file is a convenience for local development
// ONLY, and it is strictly a fallback: a variable already present in the real
// process environment always wins, so an operator can override any value without
// editing the file.
const DotEnvFile = ".env"

// LoadDotEnv populates the process environment from the optional .env file.
// It is a no-op when the file does not exist, which keeps container and CI runs
// (which inject real environment variables) working untouched.
//
// It returns an error only for a malformed line, because silently ignoring a
// typo such as "JWT_SECRET" with no "=" would leave the operator staring at an
// unrelated "JWT_SECRET is required" message instead of the real cause.
func LoadDotEnv(path string) error {
	file, err := os.Open(path) //nolint:gosec // fixed local path from the documented runbook
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("config: open %s: %w", path, err)
	}
	defer func() {
		// A read-only handle: nothing to release on the error path matters,
		// and the close error cannot affect the outcome of parsing.
		_ = file.Close()
	}()

	scanner := bufio.NewScanner(file)
	for lineNo := 1; scanner.Scan(); lineNo++ {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")

		key, value, found := strings.Cut(line, "=")
		key = strings.TrimSpace(key)
		if !found || key == "" {
			return fmt.Errorf("config: %s line %d: expected KEY=VALUE, got %q", path, lineNo, line)
		}
		if _, alreadySet := os.LookupEnv(key); alreadySet {
			// The real environment wins over the file.
			continue
		}
		if err := os.Setenv(key, unquoteDotEnvValue(strings.TrimSpace(value))); err != nil {
			return fmt.Errorf("config: set %s from %s: %w", key, path, err)
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("config: read %s: %w", path, err)
	}
	return nil
}

// unquoteDotEnvValue strips one layer of matching quotes so a value containing
// spaces or a trailing comment survives, and drops an unquoted trailing comment.
func unquoteDotEnvValue(value string) string {
	if len(value) >= 2 {
		first, last := value[0], value[len(value)-1]
		if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
			return value[1 : len(value)-1]
		}
	}
	if comment := strings.Index(value, " #"); comment >= 0 {
		return strings.TrimSpace(value[:comment])
	}
	return value
}
