package migrations

import (
	"strconv"
	"strings"
	"sync"
)

// maxVersionOnce caches the highest migration version parsed from the
// embedded FS. Parsing runs once per process (at first use, i.e. startup in
// production): the file set is fixed at compile time, so re-scanning the
// directory on every /settings/system read would be pure waste.
var maxVersionCached = sync.OnceValue(parseMaxVersion)

// MaxVersion returns the highest migration version available in the embedded
// FS. It parses the numeric prefix of every *.up.sql file once and caches
// the result; a file that does not start with digits is ignored so a stray
// README can never poison the version.
func MaxVersion() int {
	return maxVersionCached()
}

// parseMaxVersion scans the embedded FS for *.up.sql files and returns the
// largest leading-digit prefix. Zero means "no migrations embedded", which
// can only happen on a broken build.
func parseMaxVersion() int {
	entries, err := FS.ReadDir(".")
	if err != nil {
		return 0
	}
	max := 0
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".up.sql") {
			continue
		}
		i := 0
		for i < len(name) && name[i] >= '0' && name[i] <= '9' {
			i++
		}
		if i == 0 {
			continue
		}
		if v, err := strconv.Atoi(name[:i]); err == nil && v > max {
			max = v
		}
	}
	return max
}
