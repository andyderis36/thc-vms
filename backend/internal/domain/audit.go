package domain

import (
	"context"
	"strings"
	"time"
)

// This file owns the HYBRID audit-trail contract: the append-only audit_log
// rows every auditable MVP action feeds (migration 000007, queries/audit.sql).
//
// HYBRID means two write modes behind one port:
//  1. In-transaction (AppendInTx on the repository adapter): the mutation and
//     its audit row commit or roll back together. Every audited repository
//     mutation (user/location/visit writes below) uses it, so a mutation
//     without its audit row (or the reverse) is impossible.
//  2. Standalone best-effort (Append): login success/failed rows, which guard
//     no mutation. They never fail the request; the caller logs and continues
//     exactly like UpdateLastLogin.
//
// DELIBERATELY OUT OF SCOPE: visit status transitions (requested, approved,
// rejected, visiting, completed, cancelled, not_visit, rescheduled) stay ONLY
// in status_history via visitRepository.UpdateStatus/Reschedule. No audit
// event exists for them, so the trail can never duplicate the lifecycle. The
// only visit event here is visit.delete, which has no status_history row
// (the whole row, history included, is purged by ON DELETE CASCADE).
//
// SECRECY: metadata never carries passwords, hashes or tokens. SanitizeMetadata
// strips them at the repository boundary, and the login callers never put them
// in. There is no per-request logging middleware: rows are written only by the
// explicit call sites below, after authorisation has passed.

// Audit event vocabulary: the closed set of MVP actions. The strings are the
// stored action column verbatim.
const (
	AuditActionLoginSuccess   = "auth.login.success"
	AuditActionLoginFailed    = "auth.login.failed"
	AuditActionUserCreate     = "user.create"
	AuditActionUserUpdate     = "user.update"
	AuditActionUserStatus     = "user.status"
	AuditActionUserDelete     = "user.delete"
	AuditActionLocationCreate = "location.create"
	AuditActionLocationUpdate = "location.update"
	AuditActionLocationDelete = "location.delete"
	AuditActionPurposeCreate  = "purpose.create"
	AuditActionPurposeUpdate  = "purpose.update"
	AuditActionPurposeDelete  = "purpose.delete"
	AuditActionVisitDelete    = "visit.delete"
	AuditActionSettingsUpdate = "settings.update"
)

// Audit entity vocabulary: the stored entity column verbatim.
const (
	AuditEntityAuth     = "auth"
	AuditEntityUser     = "user"
	AuditEntityLocation = "location"
	AuditEntityPurpose  = "purpose"
	AuditEntityVisit    = "visit"
	AuditEntitySettings = "settings"
)

// AuditMVPEvents is the canonical closed list: 2 auth + 4 user + 3 location +
// 3 purpose + 1 visit-delete. Tests pin it so a new event (notably any
// status-transition duplicate) cannot slip in unnoticed.
func AuditMVPEvents() []string {
	return []string{
		AuditActionLoginSuccess,
		AuditActionLoginFailed,
		AuditActionUserCreate,
		AuditActionUserUpdate,
		AuditActionUserStatus,
		AuditActionUserDelete,
		AuditActionLocationCreate,
		AuditActionLocationUpdate,
		AuditActionLocationDelete,
		AuditActionPurposeCreate,
		AuditActionPurposeUpdate,
		AuditActionPurposeDelete,
		AuditActionVisitDelete,
		AuditActionSettingsUpdate,
	}
}

// IsAuditMVPEvent reports whether action is one of the ten auditable MVP
// events. The repository refuses anything else with ErrValidation, so a typo
// at a call site surfaces loudly instead of silently widening the trail.
func IsAuditMVPEvent(action string) bool {
	for _, known := range AuditMVPEvents() {
		if action == known {
			return true
		}
	}
	return false
}

// AuditEntry is the single input to every audit write: the acting user (nil
// for system/failed-login rows, mirroring status_history.changed_by), what
// happened to which row, where it came from, and a small secret-free fact bag.
type AuditEntry struct {
	ActorID   *UUID
	Action    string
	Entity    string
	EntityID  *UUID
	IP        string
	UserAgent string
	Metadata  map[string]string
}

// Limits keep one row small and non-abusive: overlong values are truncated,
// never rejected, so audit can never break its caller.
const (
	maxAuditIPLen        = 64
	maxAuditUserAgentLen = 512
	maxAuditMetaKeys     = 16
	maxAuditMetaValueLen = 500
)

// secretSubstrings marks metadata keys that must never reach the store.
// Matching is case-insensitive substring on the key: password_hash, passwd,
// access_token, client_secret and plain hash/authorization all hit.
var secretSubstrings = []string{"password", "passwd", "pwd", "token", "secret", "hash", "authorization"}

// SanitizeMetadata returns a copy of meta with secret-bearing keys removed and
// every value truncated to maxAuditMetaValueLen. A nil input stays nil (SQL
// NULL); an overfull map keeps an arbitrary first maxAuditMetaKeys keys —
// callers pass ≤ 4, so the cap only bites on programmer error.
func SanitizeMetadata(meta map[string]string) map[string]string {
	if meta == nil {
		return nil
	}
	out := make(map[string]string, len(meta))
	for key, value := range meta {
		lowered := strings.ToLower(key)
		secret := false
		for _, banned := range secretSubstrings {
			if strings.Contains(lowered, banned) {
				secret = true
				break
			}
		}
		if secret {
			continue
		}
		if len(value) > maxAuditMetaValueLen {
			value = value[:maxAuditMetaValueLen]
		}
		out[key] = value
		if len(out) >= maxAuditMetaKeys {
			break
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// TruncateAuditEntry caps the free-text carriers of one entry in place.
func TruncateAuditEntry(entry AuditEntry) AuditEntry {
	if len(entry.IP) > maxAuditIPLen {
		entry.IP = entry.IP[:maxAuditIPLen]
	}
	if len(entry.UserAgent) > maxAuditUserAgentLen {
		entry.UserAgent = entry.UserAgent[:maxAuditUserAgentLen]
	}
	entry.Metadata = SanitizeMetadata(entry.Metadata)
	return entry
}

// AuditLog is one stored trail row projected to the domain.
type AuditLog struct {
	ID        UUID
	UserID    *UUID
	Action    string
	Entity    string
	EntityID  *UUID
	Timestamp time.Time
	IP        string
	UserAgent string
	Metadata  map[string]string
}

// AuditFilter scopes ListAuditLogs. Every member is optional: nil/empty means
// unfiltered (rendered as SQL NULL, never as dropped predicates). Q is a
// free-text needle matched case-insensitively across the trail row and its
// actor. Order is the sort direction of timestamp (and its id tiebreaker).
// Limit is clamped to 1..200, defaulting to 50; Offset floors at 0.
type AuditFilter struct {
	UserID *UUID
	Entity string
	Action string
	Q      string
	Order  string
	From   *time.Time
	To     *time.Time
	Limit  int
	Offset int
}

// NormaliseAuditFilter applies the Limit/Offset defaults, trims the free-text
// needle, and pins Order to the asc/desc vocabulary (default desc).
func NormaliseAuditFilter(filter AuditFilter) AuditFilter {
	filter.Q = strings.TrimSpace(filter.Q)
	switch strings.ToLower(strings.TrimSpace(filter.Order)) {
	case "asc":
		filter.Order = "asc"
	default:
		filter.Order = "desc"
	}
	if filter.Limit <= 0 {
		filter.Limit = 50
	}
	if filter.Limit > 200 {
		filter.Limit = 200
	}
	if filter.Offset < 0 {
		filter.Offset = 0
	}
	return filter
}

// AuditRepository is the narrow port the PostgreSQL adapter implements: one
// standalone append plus the filtered read with its companion count. The
// in-transaction append lives on the concrete adapter (AppendInTx) and on the
// Audited* interfaces below, not here, so this port stays pgx-free and fakes
// stay one method each.
type AuditRepository interface {
	Append(ctx context.Context, entry AuditEntry) (AuditLog, error)
	List(ctx context.Context, filter AuditFilter) (items []AuditLog, total int64, err error)
}

// AuditedUserRepository is the optional same-transaction account port: each
// mutation commits its row and its audit row atomically. Handlers resolve it
// with a type assertion and fall back to the plain port plus best-effort
// Append when a narrow fake is mounted (the securityDeleteStore precedent).
type AuditedUserRepository interface {
	CreateUserAudited(ctx context.Context, user User, audit AuditEntry) (User, error)
	CreateManagedUserAudited(ctx context.Context, user User, audit AuditEntry) (User, error)
	UpdateManagedUserAudited(ctx context.Context, id UUID, patch ManagedUserPatch, audit AuditEntry) (User, error)
	UpdateUserStatusAudited(ctx context.Context, id UUID, status UserStatus, audit AuditEntry) error
	DeleteUserAudited(ctx context.Context, id UUID, audit AuditEntry) error
}

// AuditedLocationRepository is the optional same-transaction facility port.
type AuditedLocationRepository interface {
	CreateLocationAudited(ctx context.Context, loc Location, audit AuditEntry) (Location, error)
	UpdateLocationAudited(ctx context.Context, id UUID, patch LocationPatch, audit AuditEntry) (Location, error)
	DeleteLocationAudited(ctx context.Context, id UUID, audit AuditEntry) error
}

// AuditedPurposeRepository is the optional same-transaction purpose port.
type AuditedPurposeRepository interface {
	CreatePurposeAudited(ctx context.Context, purpose Purpose, audit AuditEntry) (Purpose, error)
	UpdatePurposeAudited(ctx context.Context, id UUID, patch PurposePatch, audit AuditEntry) (Purpose, error)
	DeletePurposeAudited(ctx context.Context, id UUID, audit AuditEntry) error
}

// AuditedVisitRepository is the optional same-transaction purge port: the only
// visit write that feeds the audit trail (status moves stay in status_history).
type AuditedVisitRepository interface {
	DeleteVisitAudited(ctx context.Context, id UUID, audit AuditEntry) error
}

// RequestMeta carries the network provenance of one request: client IP and
// User-Agent. It travels in the context from the delivery layer (which reads
// the Gin request) to the usecase/repository audit call sites.
type RequestMeta struct {
	IP        string
	UserAgent string
}

// requestMetaKey is the private context key for RequestMeta.
type requestMetaKey struct{}

// RequestMetaFor builds a RequestMeta with the audit length caps applied, so
// handlers never need to truncate inline.
func RequestMetaFor(ip, userAgent string) RequestMeta {
	if len(ip) > maxAuditIPLen {
		ip = ip[:maxAuditIPLen]
	}
	if len(userAgent) > maxAuditUserAgentLen {
		userAgent = userAgent[:maxAuditUserAgentLen]
	}
	return RequestMeta{IP: ip, UserAgent: userAgent}
}

// ContextWithRequestMeta stores the request provenance on ctx.
func ContextWithRequestMeta(ctx context.Context, meta RequestMeta) context.Context {
	return context.WithValue(ctx, requestMetaKey{}, meta)
}

// RequestMetaFromContext returns the provenance stored by
// ContextWithRequestMeta. The second result is false when no delivery layer
// stored one (background worker, hermetic tests): callers emit the audit row
// with empty IP/UA rather than failing.
func RequestMetaFromContext(ctx context.Context) (RequestMeta, bool) {
	meta, ok := ctx.Value(requestMetaKey{}).(RequestMeta)
	return meta, ok
}
