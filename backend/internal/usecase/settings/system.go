package settings

import (
	"context"
)

// AppliedVersionSource reports the highest migration version applied to the
// database, or (nil, nil) when none is applied yet. The PostgreSQL system
// adapter satisfies it; tests mount an in-memory fixture.
type AppliedVersionSource interface {
	AppliedMaxVersion(ctx context.Context) (*int, error)
}

// MailQueueStats reports the async mailer backlog for observability. The
// SMTP adapter satisfies it; tests mount an in-memory fixture.
type MailQueueStats interface {
	QueueDepth() int
	Dropped() int64
}

// MailerStatus is the mailer half of the system probe.
type MailerStatus struct {
	QueueDepth int
	Dropped    int64
}

// SystemStatus is the read-only observability snapshot behind
// GET /settings/system: the applied vs embedded migration versions, whether
// they agree, and the mailer backlog. DBVersion is nil when no migration is
// applied yet.
type SystemStatus struct {
	DBVersion   *int
	RepoVersion int
	InSync      bool
	Mailer      MailerStatus
}

// WithSystem wires the optional observability seams. All three are optional:
// a nil versions source reads DBVersion as nil, a nil stats source reads a
// zero mailer snapshot, and a zero repo version disables the sync
// comparison. It returns the same service for chained wiring at the
// composition root, mirroring the repository With* builders.
func (s *Service) WithSystem(versions AppliedVersionSource, stats MailQueueStats, repoVersion int) *Service {
	s.versions = versions
	s.mailStats = stats
	s.repoVersion = repoVersion
	return s
}

// SystemStatus assembles the observability snapshot. A versions-source
// failure is returned (the probe must not mask a sick database); mailer
// stats are best-effort by construction (a nil source reads zero).
func (s *Service) SystemStatus(ctx context.Context) (SystemStatus, error) {
	var out SystemStatus
	out.RepoVersion = s.repoVersion
	if s.versions != nil {
		dbVersion, err := s.versions.AppliedMaxVersion(ctx)
		if err != nil {
			return SystemStatus{}, err
		}
		out.DBVersion = dbVersion
	}
	if s.mailStats != nil {
		out.Mailer = MailerStatus{QueueDepth: s.mailStats.QueueDepth(), Dropped: s.mailStats.Dropped()}
	}
	out.InSync = out.DBVersion != nil && *out.DBVersion == out.RepoVersion
	return out, nil
}
