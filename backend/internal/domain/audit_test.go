package domain

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestAuditMVPEvents_IsAClosedSetOfTen(t *testing.T) {
	events := AuditMVPEvents()
	if len(events) != 10 {
		t.Fatalf("MVP events = %d, want 10: %v", len(events), events)
	}
	seen := map[string]bool{}
	for _, event := range events {
		if seen[event] {
			t.Fatalf("duplicate event %q", event)
		}
		seen[event] = true
		if !IsAuditMVPEvent(event) {
			t.Fatalf("IsAuditMVPEvent(%q) = false, want true", event)
		}
	}
	for _, want := range []string{
		AuditActionLoginSuccess, AuditActionLoginFailed,
		AuditActionUserCreate, AuditActionUserUpdate, AuditActionUserStatus, AuditActionUserDelete,
		AuditActionLocationCreate, AuditActionLocationUpdate, AuditActionLocationDelete,
		AuditActionVisitDelete,
	} {
		if !seen[want] {
			t.Fatalf("event %q missing from the closed set", want)
		}
	}
	if IsAuditMVPEvent("visit.approve") || IsAuditMVPEvent("auth.login") || IsAuditMVPEvent("") {
		t.Fatal("unknown actions must not be MVP events")
	}
}

func TestAuditMVPEvents_NeverDuplicatesStatusHistory(t *testing.T) {
	lifecycle := []string{
		"requested", "approved", "rejected", "visiting",
		"completed", "cancelled", "not_visit", "rescheduled",
		"visit.approve", "visit.reject", "visit.checkin", "visit.checkout",
		"visit.reschedule", "visit.cancel", "visit.status",
	}
	for _, event := range AuditMVPEvents() {
		for _, status := range lifecycle {
			if event == status || strings.Contains(event, status) {
				t.Fatalf("audit event %q duplicates status_history vocabulary %q", event, status)
			}
		}
	}
}

func TestSanitizeMetadata_StripsEverySecretKey(t *testing.T) {
	in := map[string]string{
		"email":            "admin@thc.local",
		"role":             "admin",
		"password":         "Password123!",
		"PasswordHash":     "$2a$10$secrethash",
		"current_password": "old-secret",
		"access_token":     "eyJhbGciOi",
		"refreshToken":     "refresh-secret",
		"client_secret":    "shhh",
		"hash":             "deadbeef",
		"authorization":    "Bearer abc",
	}
	out := SanitizeMetadata(in)
	for key := range out {
		lowered := strings.ToLower(key)
		for _, banned := range []string{"password", "token", "secret", "hash", "authorization"} {
			if strings.Contains(lowered, banned) {
				t.Fatalf("sanitized metadata still carries secret key %q", key)
			}
		}
	}
	if out["email"] != "admin@thc.local" || out["role"] != "admin" {
		t.Fatalf("innocent keys must survive, got %v", out)
	}
	if SanitizeMetadata(nil) != nil {
		t.Fatal("nil metadata must stay nil (SQL NULL)")
	}
	if SanitizeMetadata(map[string]string{"password": "x"}) != nil {
		t.Fatal("all-secret metadata must collapse to nil, not an empty object")
	}
}

func TestSanitizeMetadata_TruncatesLongValues(t *testing.T) {
	out := SanitizeMetadata(map[string]string{"email": strings.Repeat("a", 600)})
	if len(out["email"]) != maxAuditMetaValueLen {
		t.Fatalf("value length = %d, want %d", len(out["email"]), maxAuditMetaValueLen)
	}
}

func TestRequestMeta_ContextRoundTrip(t *testing.T) {
	if _, ok := RequestMetaFromContext(context.Background()); ok {
		t.Fatal("empty context must report no provenance")
	}
	want := RequestMetaFor("192.168.1.10", "UnitTest/1.0")
	got, ok := RequestMetaFromContext(ContextWithRequestMeta(context.Background(), want))
	if !ok || got != want {
		t.Fatalf("round trip = %+v,%v want %+v,true", got, ok, want)
	}
	overlong := RequestMetaFor(strings.Repeat("1", 100), strings.Repeat("A", 900))
	if len(overlong.IP) != maxAuditIPLen || len(overlong.UserAgent) != maxAuditUserAgentLen {
		t.Fatal("RequestMetaFor must apply the length caps")
	}
}

func TestNormaliseAuditFilter_DefaultsAndClamps(t *testing.T) {
	got := NormaliseAuditFilter(AuditFilter{})
	if got.Limit != 50 || got.Offset != 0 || got.Order != "desc" || got.Q != "" {
		t.Fatalf("defaults = %+v, want limit 50 offset 0 order desc", got)
	}
	got = NormaliseAuditFilter(AuditFilter{Limit: 5000, Offset: -3})
	if got.Limit != 200 || got.Offset != 0 {
		t.Fatalf("clamps = %+v, want limit 200 offset 0", got)
	}
	for _, raw := range []string{"ASC", " asc ", "Asc"} {
		if order := NormaliseAuditFilter(AuditFilter{Order: raw}).Order; order != "asc" {
			t.Fatalf("order %q normalised to %q, want asc", raw, order)
		}
	}
	for _, raw := range []string{"", "desc", "DESC", "sideways", "ascending"} {
		if order := NormaliseAuditFilter(AuditFilter{Order: raw}).Order; order != "desc" {
			t.Fatalf("order %q normalised to %q, want desc", raw, order)
		}
	}
	if q := NormaliseAuditFilter(AuditFilter{Q: "  audit actor  "}).Q; q != "audit actor" {
		t.Fatalf("q = %q, want trimmed needle", q)
	}
	from := time.Now()
	to := from.Add(time.Hour)
	actor := UUID("user-1")
	kept := NormaliseAuditFilter(AuditFilter{UserID: &actor, Entity: "user", Action: AuditActionUserCreate, Q: "tek", Order: "asc", From: &from, To: &to, Limit: 10, Offset: 5})
	if kept.UserID != &actor || kept.Entity != "user" || kept.Q != "tek" || kept.Order != "asc" || kept.From != &from || kept.To != &to || kept.Limit != 10 || kept.Offset != 5 {
		t.Fatalf("explicit filters must survive: %+v", kept)
	}
}
